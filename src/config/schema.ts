import { z } from 'zod';
import {
  type Dashboard,
  type DashboardInput,
  DashboardListSchema,
  type View,
  type ViewInput,
  ViewListSchema,
} from '../dashboards/schema.js';

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
interface WriterOut {
  chunkTargetBytes: number;
  flushIntervalMs: number;
  dedupeCapacity: number;
  facetValueCap: number;
  facetKeyCap: number;
  metricSeriesCap: number;
  metricExemplars: number;
  drop: DropOut;
}
interface WriterIn {
  chunkTargetBytes?: number | undefined;
  flushIntervalMs?: number | undefined;
  dedupeCapacity?: number | undefined;
  facetValueCap?: number | undefined;
  facetKeyCap?: number | undefined;
  metricSeriesCap?: number | undefined;
  metricExemplars?: number | undefined;
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
  eagerBudgetBytes: number;
  listCap: number;
  theme: 'system' | 'light' | 'dark';
  defaultDashboard: string;
  home: 'traces' | 'logs' | 'metrics' | 'dashboards';
}
interface ViewerIn {
  eagerBudgetBytes?: number | undefined;
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
    chunkTargetBytes: posInt.default(4_000_000),
    flushIntervalMs: posInt.default(5_000),
    dedupeCapacity: posInt.default(200_000),
    facetValueCap: posInt.default(1_000),
    facetKeyCap: posInt.default(500),
    metricSeriesCap: posInt.default(1_000),
    metricExemplars: posInt.default(4),
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
    eagerBudgetBytes: posInt.default(75_000_000),
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
