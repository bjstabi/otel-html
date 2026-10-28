import { z } from 'zod';

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
interface ViewerOut {
  eagerBudgetBytes: number;
  listCap: number;
  theme: 'system' | 'light' | 'dark';
}
interface ViewerIn {
  eagerBudgetBytes?: number | undefined;
  listCap?: number | undefined;
  theme?: 'system' | 'light' | 'dark' | undefined;
}
export interface ResolvedConfig {
  title?: string | undefined;
  writer: WriterOut;
  viewer: ViewerOut;
}
export interface ConfigInput {
  title?: string | undefined;
  writer?: WriterIn | undefined;
  viewer?: ViewerIn | undefined;
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

const ViewerSchema = z
  .strictObject({
    eagerBudgetBytes: posInt.default(75_000_000),
    listCap: posInt.default(10_000),
    theme: z.enum(['system', 'light', 'dark']).default('system'),
  })
  .prefault({});

export const ConfigSchema: z.ZodType<ResolvedConfig, ConfigInput> = z.strictObject({
  title: z.string().optional(),
  writer: WriterSchema,
  viewer: ViewerSchema,
});
