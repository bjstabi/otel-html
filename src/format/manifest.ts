import { z } from 'zod';
import type { ResolvedConfig, ResolvedDashboard } from '../config/schema.js';
import {
  DashboardShapeSchema,
  listIssues,
  RESERVED_DASHBOARD_IDS,
  type View,
  ViewListShapeSchema,
} from '../dashboards/schema.js';
import { OtelHtmlError } from '../model/errors.js';
import { type RollupTable, TABLES, type Table } from './parquet/columns.js';
import type { FileStatistics } from './parquet/stats.js';
import {
  ASSETS_BASE_RE,
  chunkPath,
  ENGINE_VERSION_RE,
  partitionFilePath,
  SIGNALS,
  type Signal,
} from './paths.js';
import { describe, parseWith } from './validate.js';
import {
  CHUNK_READABLE_FORMAT_VERSIONS,
  type FormatVersion,
  oldFormatMessage,
  READABLE_FORMAT_VERSIONS,
  READABLE_PARTITION_FORMATS,
} from './version.js';

export interface ManifestChunk {
  signal: Signal;
  n: number;
  path: string;
  start: number;
  end: number;
  count: number;
  bytes: number;
}

export interface Manifest {
  formatVersion: FormatVersion;
  otelHtmlVersion: string;
  title: string;
  epochUnixNano: string;
  createdAt: string;
  updatedAt: string;
  complete: boolean;
  range: { start: number; end: number } | null;
  totals: Record<Signal, number>;
  decodedBytes: number;
  chunks: ManifestChunk[];
  rollups: string[];
  traceShards: string[];
  /** Series files under `data/metrics/` (series, segments, levels, exemplars); absent before M3. */
  metricFiles: string[];
  config: {
    viewer: ResolvedConfig['viewer'] & { eagerBudgetBytes: number };
    dashboards: ResolvedDashboard[];
    views: View[];
  };
}

const nonNegInt = z.number().int().nonnegative();
const signal = z.enum(SIGNALS);

// The viewer loads these entries as script sources, so each must be exactly a layout path: relative,
// no scheme, no `..`, no leading `_`, nothing outside `data/`.
const CHUNK_PATH = /^data\/chunks\/(spans|logs|metrics)\/[0-9]{6,}\.js$/;
// A formats 1 to 3 metric data file: the metric id, then the file name (series, a flush segment, or a level and page).
const METRIC_FILE_PATH =
  /^data\/metrics\/([0-9]{6})\/(series|seg-([0-9]{6})|l([0-6])(?:-([0-9]{6}))?|ex([3-6])?(?:-([0-9]{6}))?)\.js$/;
const ROLLUP_PATH = /^data\/rollups\/[a-z][a-z0-9-]*\.js$/;
const TRACE_SHARD_PATH = /^data\/traces\/[0-9a-f]{2}\.js$/;

const viewerShape = {
  listCap: z.number().int().positive(),
  theme: z.enum(['system', 'light', 'dark']),
  defaultDashboard: z.string().default('fusion'),
  home: z.enum(['traces', 'logs', 'metrics', 'dashboards']).default('traces'),
};

/** The v1 to v3 config: its viewer still carries `eagerBudgetBytes`. */
const ConfigSchema = z.strictObject({
  viewer: z.strictObject({ eagerBudgetBytes: z.number().int().positive(), ...viewerShape }),
  dashboards: z.array(z.strictObject({ source: z.string(), dashboard: DashboardShapeSchema })).default([]),
  // Shape only: a report stored by an older build may hold a query this build's compiler rejects; the widget shows that error.
  views: ViewListShapeSchema.default([]),
});

/** The partition config (format 5): no `eagerBudgetBytes` (the partition viewer has no eager mode). */
const ConfigSchemaV5 = z.strictObject({
  viewer: z.strictObject({
    ...viewerShape,
    // The writer's facet caps, which the viewer applies to its facet results; absent in a report that predates them.
    facetValueCap: z.exactOptional(z.number().int().positive()),
    facetKeyCap: z.exactOptional(z.number().int().positive()),
    // The default time window of the landing pages (a duration like 7d).
    defaultWindow: z.exactOptional(z.string().regex(/^[1-9][0-9]*(m|h|d)$/, 'a window like 7d, 90m or 1h')),
  }),
  dashboards: ConfigSchema.shape.dashboards,
  views: ConfigSchema.shape.views,
});

function refineConfig(
  config: { viewer: { defaultDashboard: string }; dashboards: ResolvedDashboard[] },
  ctx: z.RefinementCtx,
  at: PropertyKey[],
): void {
  listIssues(
    config.dashboards.map((d) => d.dashboard.id),
    RESERVED_DASHBOARD_IDS,
    ctx,
    (i) => [...at, 'config', 'dashboards', i, 'dashboard', 'id'],
  );
  const def = config.viewer.defaultDashboard;
  if (def !== 'fusion' && !config.dashboards.some((d) => d.dashboard.id === def)) {
    ctx.addIssue({
      code: 'custom',
      path: [...at, 'config', 'viewer', 'defaultDashboard'],
      message: 'the id of a dashboard (fusion or one in config.dashboards)',
    });
  }
}

export const ManifestSchema: z.ZodType<Manifest> = z
  .strictObject({
    formatVersion: z.literal(CHUNK_READABLE_FORMAT_VERSIONS),
    otelHtmlVersion: z.string(),
    title: z.string(),
    epochUnixNano: z.string().regex(/^[0-9]+$/, 'decimal nanoseconds'),
    createdAt: z.string(),
    updatedAt: z.string(),
    complete: z.boolean(),
    range: z.strictObject({ start: z.number().int(), end: z.number().int() }).nullable(),
    totals: z.strictObject({ spans: nonNegInt, logs: nonNegInt, metrics: nonNegInt }),
    decodedBytes: nonNegInt,
    chunks: z.array(
      z.strictObject({
        signal,
        n: nonNegInt,
        path: z.string().regex(CHUNK_PATH, 'a chunk path like data/chunks/spans/000000.js'),
        start: z.number().int(),
        end: z.number().int(),
        count: nonNegInt,
        bytes: nonNegInt,
      }),
    ),
    rollups: z.array(z.string().regex(ROLLUP_PATH, 'a rollup path like data/rollups/spans.js')),
    traceShards: z.array(z.string().regex(TRACE_SHARD_PATH, 'a trace shard path like data/traces/5b.js')),
    metricFiles: z
      .array(z.string().regex(METRIC_FILE_PATH, 'a metric file path like data/metrics/000000/l0.js'))
      .default([]),
    config: ConfigSchema,
  })
  .superRefine((m, ctx) => {
    refineConfig(m.config, ctx, []);
    m.chunks.forEach((c, i) => {
      const expected = chunkPath(c.signal, c.n);
      if (c.path !== expected) {
        ctx.addIssue({ code: 'custom', path: ['chunks', i, 'path'], message: expected });
      }
    });
  });

/** Validate an untrusted manifest payload; failures are `invalid-report` errors with a precise path. */
export function parseManifest(input: unknown): Manifest {
  return parseWith(ManifestSchema, input, 'manifest');
}

/** The one grain every rollup file uses: 2^16 milliseconds in nanoseconds. */
export const ROLLUP_GRAIN_NS = 65_536_000_000;

/** What a rollup file groups by (format 5). `dimensions` use the statistics-key grammar, sorted. */
export interface RollupDescription {
  grainNs: typeof ROLLUP_GRAIN_NS;
  dimensions: string[];
  durationBuckets?: 'log2x8';
  /** Format 7: the sorted widget keys a writer weighed and refused to roll up. */
  refused?: string[];
}

/** Format 7, the `widget_traces` file only: the conditions (hashes) and variable keys its rows cover, sorted. */
export interface WidgetIndexDescription {
  /** The `WIDGET_INDEX_EVALUATOR` of the writer; absent in an index written before the field (it counts as a mismatch). */
  evaluator?: number;
  conditions: string[];
  variables: string[];
}

export interface PartitionFile extends FileStatistics {
  path: string;
  bytes: number;
  /** Format 5, `spans` and `traces` files: the largest end time (int64 text), `null` for no rows. */
  timeEndMax?: string | null;
  /** Format 5, the two rollup tables only, where it is required. */
  rollup?: RollupDescription;
  /** Format 6, the `traces` file only: its rows carry `service_share`. */
  serviceShare?: true;
  /** Format 7, the `widget_traces` file only, where it is required. */
  widgetIndex?: WidgetIndexDescription;
  /**
   * Format 7, `spans` and `logs` files: each attribute key and how many of the file's attribute entries hold a scalar
   * value for it (what `attributeFacetsQuery` counts as the key's total). Absent when the writer did not record it
   * (an older file, or one with more than 1000 distinct keys).
   */
  attributeKeys?: Record<string, number>;
}

/** The five base tables are always listed; the two rollup tables only when the report has rollups. */
export type StatisticsKeys = Record<Exclude<Table, RollupTable | 'widget_traces'>, string[]> &
  Partial<Record<RollupTable, string[]>>;

export interface PartitionEntry {
  n: number;
  source: string;
  files: Partial<Record<Table, PartitionFile>>;
}

export interface ManifestV4 {
  /** 5, 6 or 7; the type keeps its name from format 4. */
  formatVersion: (typeof READABLE_PARTITION_FORMATS)[number];
  otelHtmlVersion: string;
  title: string;
  /** Format 5: stored. Format 6 stores none; the parse fills the anchor (`range.start`, else `createdAt` in ns). */
  epochUnixNano: string;
  createdAt: string;
  updatedAt: string;
  complete: boolean;
  /** Absolute int64 nanosecond text, like every other v4 time. */
  range: { start: string; end: string } | null;
  totals: Record<Signal, number>;
  partitions: PartitionEntry[];
  statisticsKeys: StatisticsKeys;
  engine: { version: string; format: 'local' | 'site'; assetsBase: string };
  config: {
    viewer: ResolvedConfig['viewer'] & { facetValueCap?: number; facetKeyCap?: number };
    dashboards: ResolvedDashboard[];
    views: View[];
  };
}

export type AnyManifest = Manifest | ManifestV4;

export const SOURCE_RE: RegExp = /^(flush|compact|job|ci|merge):[A-Za-z0-9#:._-]{1,200}$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT64_CANONICAL = /^(?:0|-?[1-9][0-9]*)$/;
/** `a > b` for two int64 texts; false when either is not canonical (the field's own issue reports that). */
const after = (a: string, b: string): boolean =>
  INT64_CANONICAL.test(a) && INT64_CANONICAL.test(b) && BigInt(a) > BigInt(b);
const int64Text = z
  .string()
  .regex(INT64_CANONICAL, 'canonical decimal int64 text')
  .refine((t) => {
    if (!INT64_CANONICAL.test(t)) return true;
    const n = BigInt(t);
    return n >= INT64_MIN && n <= INT64_MAX;
  }, 'a value within signed 64 bits');

const BASE_TABLES = ['spans', 'logs', 'points', 'traces', 'patterns'] as const;

const tableKeyed = <T extends z.ZodType>(
  v: T,
): z.ZodObject<Record<(typeof BASE_TABLES)[number], T>, z.core.$strict> =>
  z.strictObject({ spans: v, logs: v, points: v, traces: v, patterns: v });

const PartitionFileShape = {
  path: z.string(),
  bytes: nonNegInt,
  rows: nonNegInt,
  timeMin: int64Text.nullable(),
  timeMax: int64Text.nullable(),
  values: z.record(z.string(), z.array(z.string()).nullable()),
};

/** A partition file entry without a format-5 field; the entry of every table that has none. */
export const PartitionFileSchema: z.ZodType<PartitionFile> = z.strictObject(PartitionFileShape);

const RollupDescriptionShape = {
  grainNs: z.literal(ROLLUP_GRAIN_NS),
  dimensions: z.array(z.string()),
  durationBuckets: z.exactOptional(z.literal('log2x8')),
};
const RollupDescriptionSchema: z.ZodType<RollupDescription> = z.strictObject(RollupDescriptionShape);
const RollupDescriptionSchemaV7: z.ZodType<RollupDescription> = z.strictObject({
  ...RollupDescriptionShape,
  refused: z.exactOptional(z.array(z.string())),
});

const TimeEndPartitionFileSchema: z.ZodType<PartitionFile> = z.strictObject({
  ...PartitionFileShape,
  timeEndMax: z.exactOptional(int64Text.nullable()),
});

/** A format-6 `traces` file: `timeEndMax` and, when its rows carry `service_share`, `serviceShare: true`. */
export const ShareTracesPartitionFileSchema: z.ZodType<PartitionFile> = z.strictObject({
  ...PartitionFileShape,
  timeEndMax: z.exactOptional(int64Text.nullable()),
  serviceShare: z.exactOptional(z.literal(true)),
});

const AttributeKeysSchema = z.record(z.string(), z.number().int().positive());

/** A format-7 `spans` file: `timeEndMax` and, when recorded, `attributeKeys`. */
export const SpansPartitionFileSchemaV7: z.ZodType<PartitionFile> = z.strictObject({
  ...PartitionFileShape,
  timeEndMax: z.exactOptional(int64Text.nullable()),
  attributeKeys: z.exactOptional(AttributeKeysSchema),
});

/** A format-7 `logs` file: `attributeKeys` when recorded. */
export const LogsPartitionFileSchemaV7: z.ZodType<PartitionFile> = z.strictObject({
  ...PartitionFileShape,
  attributeKeys: z.exactOptional(AttributeKeysSchema),
});

const RollupPartitionFileSchema: z.ZodType<PartitionFile> = z.strictObject({
  ...PartitionFileShape,
  rollup: RollupDescriptionSchema,
});

/** A format-7 rollup file: its description may list `refused` widget keys. */
export const RollupPartitionFileSchemaV7: z.ZodType<PartitionFile> = z.strictObject({
  ...PartitionFileShape,
  rollup: RollupDescriptionSchemaV7,
});

/** A format-7 `widget_traces` file: `widgetIndex` states the conditions and variable keys it covers. */
export const WidgetTracesPartitionFileSchema: z.ZodType<PartitionFile> = z.strictObject({
  ...PartitionFileShape,
  widgetIndex: z.strictObject({
    evaluator: z.exactOptional(z.number().int().positive()),
    conditions: z.array(z.string()),
    variables: z.array(z.string()),
  }),
});

const refineManifest = (
  m: Pick<ManifestV4, 'config' | 'range' | 'partitions'>,
  ctx: z.RefinementCtx,
): void => {
  refineConfig(m.config, ctx, []);
  if (m.range !== null && after(m.range.start, m.range.end)) {
    ctx.addIssue({
      code: 'custom',
      path: ['range', 'end'],
      message: `a time at or after start (${m.range.start})`,
    });
  }
  let prev = -1;
  m.partitions.forEach((p, i) => {
    if (p.n <= prev) {
      ctx.addIssue({ code: 'custom', path: ['partitions', i, 'n'], message: `a number above ${prev}` });
    }
    prev = p.n;
    for (const t of TABLES) {
      const f = p.files[t];
      if (f?.timeMin != null && f.timeMax != null && after(f.timeMin, f.timeMax)) {
        ctx.addIssue({
          code: 'custom',
          path: ['partitions', i, 'files', t, 'timeMax'],
          message: `a time at or after timeMin (${f.timeMin})`,
        });
      }
      if (f?.timeMin != null && f.timeEndMax != null && after(f.timeMin, f.timeEndMax)) {
        ctx.addIssue({
          code: 'custom',
          path: ['partitions', i, 'files', t, 'timeEndMax'],
          message: `a time at or after timeMin (${f.timeMin})`,
        });
      }
    }
    for (const t of TABLES) {
      const f = p.files[t];
      if (f === undefined) continue;
      const expected = partitionFilePath(p.n, t);
      if (f.path !== expected) {
        ctx.addIssue({ code: 'custom', path: ['partitions', i, 'files', t, 'path'], message: expected });
      }
    }
  });
};

const ManifestShape = {
  otelHtmlVersion: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  complete: z.boolean(),
  range: z.strictObject({ start: int64Text, end: int64Text }).nullable(),
  totals: z.strictObject({ spans: nonNegInt, logs: nonNegInt, metrics: nonNegInt }),
  engine: z.strictObject({
    version: z.string().regex(ENGINE_VERSION_RE, 'an engine version like 1.4.1 (no /)'),
    format: z.enum(['local', 'site']),
    assetsBase: z.string().regex(ASSETS_BASE_RE, 'assets/ or a relative path like ../../assets/0.3.0/'),
  }),
};

const partitionEntry = <F extends z.ZodType>(files: F) =>
  z.array(
    z.strictObject({
      n: nonNegInt,
      source: z.string().regex(SOURCE_RE, 'a source like flush:3 or ci:run#12'),
      files,
    }),
  );

const partitionsV5 = (traces: z.ZodType<PartitionFile>) =>
  partitionEntry(
    z.strictObject({
      spans: z.exactOptional(TimeEndPartitionFileSchema),
      logs: z.exactOptional(PartitionFileSchema),
      points: z.exactOptional(PartitionFileSchema),
      traces: z.exactOptional(traces),
      patterns: z.exactOptional(PartitionFileSchema),
      span_rollups: z.exactOptional(RollupPartitionFileSchema),
      log_rollups: z.exactOptional(RollupPartitionFileSchema),
    }),
  );

const partitionsV7 = partitionEntry(
  z.strictObject({
    spans: z.exactOptional(SpansPartitionFileSchemaV7),
    logs: z.exactOptional(LogsPartitionFileSchemaV7),
    points: z.exactOptional(PartitionFileSchema),
    traces: z.exactOptional(ShareTracesPartitionFileSchema),
    patterns: z.exactOptional(PartitionFileSchema),
    span_rollups: z.exactOptional(RollupPartitionFileSchemaV7),
    log_rollups: z.exactOptional(RollupPartitionFileSchemaV7),
    widget_traces: z.exactOptional(WidgetTracesPartitionFileSchema),
  }),
);

const statisticsKeysV5 = z.strictObject({
  ...tableKeyed(z.array(z.string())).shape,
  span_rollups: z.exactOptional(z.array(z.string())),
  log_rollups: z.exactOptional(z.array(z.string())),
});

/** Format 5: Parquet partitions; `timeEndMax`, rollup files and their statistics keys and `viewer.defaultWindow` are optional. */
export const ManifestV5Schema: z.ZodType<ManifestV4> = z
  .strictObject({
    formatVersion: z.literal(5),
    epochUnixNano: z.string().regex(/^[0-9]+$/, 'decimal nanoseconds'),
    ...ManifestShape,
    partitions: partitionsV5(TimeEndPartitionFileSchema),
    statisticsKeys: statisticsKeysV5,
    config: ConfigSchemaV5,
  })
  .superRefine(refineManifest);

/** Unix nanoseconds, as decimal text, of an ISO time. */
const isoToUnixNano = (iso: string): string => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

/**
 * Format 6: format 5 without `epochUnixNano`, and a `traces` file may state `serviceShare: true`. The parse fills
 * `epochUnixNano` with the viewer's anchor: `range.start`, or `createdAt` in unix ns for an empty report.
 */
const ManifestV6Schema: z.ZodType<ManifestV4> = z
  .strictObject({
    formatVersion: z.literal(6),
    ...ManifestShape,
    createdAt: z.string().refine((t) => Number.isFinite(Date.parse(t)), 'an ISO time'),
    partitions: partitionsV5(ShareTracesPartitionFileSchema),
    statisticsKeys: statisticsKeysV5,
    config: ConfigSchemaV5,
  })
  .superRefine(refineManifest)
  .transform((m) => ({ ...m, epochUnixNano: m.range === null ? isoToUnixNano(m.createdAt) : m.range.start }));

/** Format 7: format 6, plus a `widget_traces` file (with `widgetIndex`) and `refused` on a rollup description. */
const ManifestV7Schema: z.ZodType<ManifestV4> = z
  .strictObject({
    formatVersion: z.literal(7),
    ...ManifestShape,
    createdAt: z.string().refine((t) => Number.isFinite(Date.parse(t)), 'an ISO time'),
    partitions: partitionsV7,
    statisticsKeys: statisticsKeysV5,
    config: ConfigSchemaV5,
  })
  .superRefine(refineManifest)
  .transform((m) => ({ ...m, epochUnixNano: m.range === null ? isoToUnixNano(m.createdAt) : m.range.start }));

/** The viewer's time anchor: format 5 stores it; a parsed format 6 carries the derived value. */
export function manifestAnchor(m: ManifestV4): bigint {
  return BigInt(m.epochUnixNano);
}

/** What goes into `data/manifest.js`: a format-6 or 7 manifest stores no `epochUnixNano`. */
export function manifestForWrite(m: AnyManifest): unknown {
  if (m.formatVersion !== 6 && m.formatVersion !== 7) return m;
  const { epochUnixNano: _anchor, ...stored } = m;
  return stored;
}

function parseManifestV5(input: unknown): ManifestV4 {
  return parseWith(ManifestV5Schema, input, 'manifest');
}

/** A partition manifest (format 5 to 7), as against a chunk manifest (formats 1 to 3). */
export function isPartitioned(m: AnyManifest): m is ManifestV4 {
  return READABLE_PARTITION_FORMATS.some((f) => f === m.formatVersion);
}

/** Dispatch on `formatVersion`: 5 to 7 are partition manifests, 1-3 a chunk manifest; format 4 gets the D12 message, anything else is invalid-report. */
export function parseAnyManifest(input: unknown): AnyManifest {
  const v =
    typeof input === 'object' && input !== null && 'formatVersion' in input ? input.formatVersion : undefined;
  if (v === 4) throw new OtelHtmlError('invalid-report', { message: oldFormatMessage(v) });
  if (v === 5) return parseManifestV5(input);
  if (v === 6) return parseWith(ManifestV6Schema, input, 'manifest');
  if (v === 7) return parseWith(ManifestV7Schema, input, 'manifest');
  if (CHUNK_READABLE_FORMAT_VERSIONS.some((c) => c === v)) return parseManifest(input);
  throw new OtelHtmlError('invalid-report', {
    path: 'manifest.formatVersion',
    expected: READABLE_FORMAT_VERSIONS.join(' | '),
    actual: describe(v),
  });
}
