import { z } from 'zod';
import type { ResolvedConfig, ResolvedDashboard } from '../config/schema.js';
import {
  DashboardSchema,
  listIssues,
  RESERVED_DASHBOARD_IDS,
  type View,
  ViewListSchema,
} from '../dashboards/schema.js';
import { METRIC_FILE_PATH } from './metric-files.js';
import { chunkPath, SIGNALS, type Signal } from './paths.js';
import { parseWith } from './validate.js';

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
  formatVersion: 1;
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

export const ManifestSchema: z.ZodType<Manifest> = z
  .strictObject({
    formatVersion: z.literal(1),
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
    config: z.strictObject({
      viewer: z.strictObject({
        eagerBudgetBytes: z.number().int().positive(),
        listCap: z.number().int().positive(),
        theme: z.enum(['system', 'light', 'dark']),
        defaultDashboard: z.string().default('fusion'),
        home: z.enum(['traces', 'logs', 'metrics', 'dashboards']).default('traces'),
      }),
      dashboards: z.array(z.strictObject({ source: z.string(), dashboard: DashboardSchema })).default([]),
      views: ViewListSchema.default([]),
    }),
  })
  .superRefine((m, ctx) => {
    listIssues(
      m.config.dashboards.map((d) => d.dashboard.id),
      RESERVED_DASHBOARD_IDS,
      ctx,
      (i) => ['config', 'dashboards', i, 'dashboard', 'id'],
    );
    const def = m.config.viewer.defaultDashboard;
    if (def !== 'fusion' && !m.config.dashboards.some((d) => d.dashboard.id === def)) {
      ctx.addIssue({
        code: 'custom',
        path: ['config', 'viewer', 'defaultDashboard'],
        message: 'the id of a dashboard (fusion or one in config.dashboards)',
      });
    }
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
