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
import { METRIC_FILE_PATH } from './metric-files.js';
import { TABLES, type Table } from './parquet/schema.js';
import type { FileStatistics } from './parquet/stats.js';
import { chunkPath, partitionFilePath, SIGNALS, type Signal } from './paths.js';
import { parseWith } from './validate.js';
import {
  CHUNK_READABLE_FORMAT_VERSIONS,
  type FormatVersion,
  PARTITION_FORMAT_VERSION,
  READABLE_FORMAT_VERSIONS,
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
  config: { viewer: ResolvedConfig['viewer']; dashboards: ResolvedDashboard[]; views: View[] };
}

const nonNegInt = z.number().int().nonnegative();
const signal = z.enum(SIGNALS);

// The viewer loads these entries as script sources, so each must be exactly a layout path: relative,
// no scheme, no `..`, no leading `_`, nothing outside `data/`.
const CHUNK_PATH = /^data\/chunks\/(spans|logs|metrics)\/[0-9]{6,}\.js$/;
const ROLLUP_PATH = /^data\/rollups\/[a-z][a-z0-9-]*\.js$/;
const TRACE_SHARD_PATH = /^data\/traces\/[0-9a-f]{2}\.js$/;

const ConfigSchema = z.strictObject({
  viewer: z.strictObject({
    eagerBudgetBytes: z.number().int().positive(),
    listCap: z.number().int().positive(),
    theme: z.enum(['system', 'light', 'dark']),
    defaultDashboard: z.string().default('fusion'),
    home: z.enum(['traces', 'logs', 'metrics', 'dashboards']).default('traces'),
  }),
  dashboards: z.array(z.strictObject({ source: z.string(), dashboard: DashboardShapeSchema })).default([]),
  // Shape only: a report stored by an older build may hold a query this build's compiler rejects; the widget shows that error.
  views: ViewListShapeSchema.default([]),
});

function refineConfig(config: Manifest['config'], ctx: z.RefinementCtx, at: PropertyKey[]): void {
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

interface PartitionFile extends FileStatistics {
  path: string;
  bytes: number;
}

interface PartitionEntry {
  n: number;
  source: string;
  files: Partial<Record<Table, PartitionFile>>;
}

export interface ManifestV4 {
  formatVersion: typeof PARTITION_FORMAT_VERSION;
  otelHtmlVersion: string;
  title: string;
  epochUnixNano: string;
  createdAt: string;
  updatedAt: string;
  complete: boolean;
  range: { start: number; end: number } | null;
  totals: Record<Signal, number>;
  partitions: PartitionEntry[];
  statisticsKeys: Record<Table, string[]>;
  engine: { version: string; format: 'local' | 'site'; assetsBase: string };
  config: Manifest['config'];
}

export type AnyManifest = Manifest | ManifestV4;

const SOURCE_RE = /^(flush|compact|job|ci|merge):[A-Za-z0-9#:._-]{1,200}$/;
// `assets/` or `../` segments then `assets/<segment>/`: relative, no scheme, no leading `_`.
const ASSETS_BASE_RE = /^(?:\.\.\/)*assets\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)?$/;
const INT64_TEXT = /^-?[0-9]{1,19}$/;

const tableKeyed = <T extends z.ZodType>(v: T): z.ZodObject<Record<Table, T>, z.core.$strict> =>
  z.strictObject({ spans: v, logs: v, points: v, traces: v, patterns: v });

const PartitionFileSchema: z.ZodType<PartitionFile> = z.strictObject({
  path: z.string(),
  bytes: nonNegInt,
  rows: nonNegInt,
  timeMin: z.string().regex(INT64_TEXT, 'decimal int64 text').nullable(),
  timeMax: z.string().regex(INT64_TEXT, 'decimal int64 text').nullable(),
  values: z.record(z.string(), z.array(z.string()).nullable()),
});

const ManifestV4Schema: z.ZodType<ManifestV4> = z
  .strictObject({
    formatVersion: z.literal(PARTITION_FORMAT_VERSION),
    otelHtmlVersion: z.string(),
    title: z.string(),
    epochUnixNano: z.string().regex(/^[0-9]+$/, 'decimal nanoseconds'),
    createdAt: z.string(),
    updatedAt: z.string(),
    complete: z.boolean(),
    range: z.strictObject({ start: z.number().int(), end: z.number().int() }).nullable(),
    totals: z.strictObject({ spans: nonNegInt, logs: nonNegInt, metrics: nonNegInt }),
    partitions: z.array(
      z.strictObject({
        n: nonNegInt,
        source: z.string().regex(SOURCE_RE, 'a source like flush:3 or ci:run#12'),
        files: z.strictObject({
          spans: z.exactOptional(PartitionFileSchema),
          logs: z.exactOptional(PartitionFileSchema),
          points: z.exactOptional(PartitionFileSchema),
          traces: z.exactOptional(PartitionFileSchema),
          patterns: z.exactOptional(PartitionFileSchema),
        }),
      }),
    ),
    statisticsKeys: tableKeyed(z.array(z.string())),
    engine: z.strictObject({
      version: z.string(),
      format: z.enum(['local', 'site']),
      assetsBase: z.string().regex(ASSETS_BASE_RE, 'assets/ or a relative path like ../../assets/0.3.0/'),
    }),
    config: ConfigSchema,
  })
  .superRefine((m, ctx) => {
    refineConfig(m.config, ctx, []);
    let prev = -1;
    m.partitions.forEach((p, i) => {
      if (p.n <= prev) {
        ctx.addIssue({ code: 'custom', path: ['partitions', i, 'n'], message: `a number above ${prev}` });
      }
      prev = p.n;
      for (const t of TABLES) {
        const f = p.files[t];
        if (f === undefined) continue;
        const expected = partitionFilePath(p.n, t);
        if (f.path !== expected) {
          ctx.addIssue({ code: 'custom', path: ['partitions', i, 'files', t, 'path'], message: expected });
        }
      }
    });
  });

function parseManifestV4(input: unknown): ManifestV4 {
  return parseWith(ManifestV4Schema, input, 'manifest');
}

export function isV4(m: AnyManifest): m is ManifestV4 {
  return m.formatVersion === PARTITION_FORMAT_VERSION;
}

/** Dispatch on `formatVersion`: 4 is a partition manifest, 1-3 a chunk manifest, anything else is invalid-report. */
export function parseAnyManifest(input: unknown): AnyManifest {
  const v =
    typeof input === 'object' && input !== null && 'formatVersion' in input ? input.formatVersion : undefined;
  if (v === PARTITION_FORMAT_VERSION) return parseManifestV4(input);
  if (CHUNK_READABLE_FORMAT_VERSIONS.some((c) => c === v)) return parseManifest(input);
  throw new OtelHtmlError('invalid-report', {
    path: 'manifest.formatVersion',
    expected: READABLE_FORMAT_VERSIONS.join(' | '),
    actual: JSON.stringify(v) ?? 'nothing (missing)',
  });
}
