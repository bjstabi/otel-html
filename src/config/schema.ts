import { z } from 'zod';
import {
  type Dashboard,
  type DashboardInput,
  DashboardListSchema,
  type View,
  type ViewInput,
  ViewListSchema,
} from '../dashboards/schema.js';
import { ASSETS_BASE_RE, DEFAULT_ASSETS_BASE } from '../format/paths.js';
import { CHUNKS_GONE } from '../format/version.js';

// Explicit input/output types keep `isolatedDeclarations` satisfied (Zod's inferred
// builder types cannot be emitted per-file). The schemas below are the source of truth;
// `ResolvedConfig`/`ConfigInput` are what callers see.

interface DropOut {
  traces: { span: string[] };
  logs: { log_record: string[] };
  metrics: { datapoint: string[] };
}
interface DropIn {
  traces?: { span?: string[] | undefined } | undefined;
  logs?: { log_record?: string[] | undefined } | undefined;
  metrics?: { datapoint?: string[] | undefined } | undefined;
}
/** The default `writer.localWarnBytes`: the Parquet size past which a `local` report warns. */
export const DEFAULT_LOCAL_WARN_BYTES = 256_000_000;

/** The report formats `writer.format` names. */
export type ReportFormat = 'local' | 'site';

interface WriterOut {
  format: ReportFormat;
  rowGroupRows: number;
  statisticsKeys: string[];
  localWarnBytes: number;
  compactOnMerge: boolean;
  assetsBase: string;
  chunkTargetBytes: number;
  flushIntervalMs: number;
  dedupeCapacity: number;
  facetValueCap: number;
  facetKeyCap: number;
  drop: DropOut;
}
interface WriterIn {
  format?: ReportFormat | undefined;
  rowGroupRows?: number | undefined;
  statisticsKeys?: string[] | undefined;
  localWarnBytes?: number | undefined;
  compactOnMerge?: boolean | undefined;
  assetsBase?: string | undefined;
  chunkTargetBytes?: number | undefined;
  flushIntervalMs?: number | undefined;
  dedupeCapacity?: number | undefined;
  facetValueCap?: number | undefined;
  facetKeyCap?: number | undefined;
  drop?: DropIn | undefined;
}
interface ListenerOut {
  enabled: boolean;
  port: number;
}
interface ListenerIn {
  enabled?: boolean | undefined;
  port?: number | undefined;
}
interface ReceiverOut {
  host: string;
  http: ListenerOut;
  grpc: ListenerOut;
  maxBodyBytes: number;
  inflightBudgetBytes: number;
}
interface ReceiverIn {
  host?: string | undefined;
  http?: ListenerIn | undefined;
  grpc?: ListenerIn | undefined;
  maxBodyBytes?: number | undefined;
  inflightBudgetBytes?: number | undefined;
}
interface ViewerOut {
  listCap: number;
  theme: 'system' | 'light' | 'dark';
  defaultDashboard: string;
  home: 'traces' | 'logs' | 'metrics' | 'dashboards';
}
interface ViewerIn {
  listCap?: number | undefined;
  theme?: 'system' | 'light' | 'dark' | undefined;
  defaultDashboard?: string | undefined;
  home?: 'traces' | 'logs' | 'metrics' | 'dashboards' | undefined;
}
/** A dashboard with where it was defined (a file name, or `library API`), shown in the viewer. */
export interface ResolvedDashboard {
  source: string;
  dashboard: Dashboard;
}
export type ReceiverConfig = ResolvedConfig['receiver'];
export interface ResolvedConfig {
  title?: string | undefined;
  writer: WriterOut;
  receiver: ReceiverOut;
  viewer: ViewerOut;
  dashboards: ResolvedDashboard[];
  views: View[];
}
export interface ConfigInput {
  title?: string | undefined;
  writer?: WriterIn | undefined;
  receiver?: ReceiverIn | undefined;
  viewer?: ViewerIn | undefined;
  dashboards?: DashboardInput[] | undefined;
  views?: ViewInput[] | undefined;
}

const posInt = z.number().int().positive();
const ottlList = z.array(z.string()).default([]);

const DropSchema = z
  .strictObject({
    traces: z.strictObject({ span: ottlList }).prefault({}),
    logs: z.strictObject({ log_record: ottlList }).prefault({}),
    metrics: z.strictObject({ datapoint: ottlList }).prefault({}),
  })
  .prefault({});

const WriterSchema = z
  .strictObject({
    format: z
      .enum(['local', 'site'], { error: (i) => (i.input === 'chunks' ? CHUNKS_GONE : undefined) })
      .default('local'),
    rowGroupRows: z.number().int().min(50_000).max(100_000).default(50_000),
    statisticsKeys: z.array(z.string()).default([]),
    localWarnBytes: posInt.default(DEFAULT_LOCAL_WARN_BYTES),
    compactOnMerge: z.boolean().default(false),
    assetsBase: z
      .string()
      .regex(ASSETS_BASE_RE, 'assets/ or a relative path like ../../assets/0.3.0/')
      .default(DEFAULT_ASSETS_BASE),
    chunkTargetBytes: posInt.default(4_000_000),
    flushIntervalMs: posInt.default(5_000),
    dedupeCapacity: posInt.default(200_000),
    facetValueCap: posInt.default(1_000),
    facetKeyCap: posInt.default(500),
    drop: DropSchema,
  })
  .prefault({});

const port = z.number().int().min(0).max(65535);

const ReceiverSchema = z
  .strictObject({
    host: z.string().min(1).default('127.0.0.1'),
    http: z.strictObject({ enabled: z.boolean().default(true), port: port.default(4318) }).prefault({}),
    grpc: z.strictObject({ enabled: z.boolean().default(true), port: port.default(4317) }).prefault({}),
    maxBodyBytes: posInt.default(67_108_864),
    inflightBudgetBytes: posInt.default(134_217_728),
  })
  .prefault({});

const ViewerSchema = z
  .strictObject({
    listCap: posInt.default(10_000),
    theme: z.enum(['system', 'light', 'dark']).default('system'),
    defaultDashboard: z.string().default('fusion'),
    home: z.enum(['traces', 'logs', 'metrics', 'dashboards']).default('traces'),
  })
  .prefault({});

export const ConfigSchema: z.ZodType<ResolvedConfig, ConfigInput> = z
  .strictObject({
    title: z.string().optional(),
    writer: WriterSchema,
    receiver: ReceiverSchema,
    viewer: ViewerSchema,
    // `config file` for a config parsed on its own; `resolveConfig` then names the layer each dashboard came from.
    dashboards: DashboardListSchema.prefault([]).transform((ds): ResolvedDashboard[] =>
      ds.map((dashboard) => ({ source: 'config file', dashboard })),
    ),
    views: ViewListSchema.default([]),
  })
  .superRefine((c, ctx) => {
    const id = c.viewer.defaultDashboard;
    if (id !== 'fusion' && !c.dashboards.some((d) => d.dashboard.id === id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['viewer', 'defaultDashboard'],
        message: 'the id of a dashboard (fusion or one in dashboards)',
      });
    }
  });
