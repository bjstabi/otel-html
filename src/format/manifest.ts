import { z } from 'zod';
import type { ResolvedConfig } from '../config/schema.js';
import { SIGNALS, type Signal } from './paths.js';
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
  config: { viewer: ResolvedConfig['viewer'] };
}

const nonNegInt = z.number().int().nonnegative();
const signal = z.enum(SIGNALS);

export const ManifestSchema: z.ZodType<Manifest> = z.strictObject({
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
      path: z.string(),
      start: z.number().int(),
      end: z.number().int(),
      count: nonNegInt,
      bytes: nonNegInt,
    }),
  ),
  rollups: z.array(z.string()),
  traceShards: z.array(z.string().regex(/^[0-9a-f]{2}$/, 'two lowercase hex chars')),
  config: z.strictObject({
    viewer: z.strictObject({
      eagerBudgetBytes: z.number().int().positive(),
      listCap: z.number().int().positive(),
      theme: z.enum(['system', 'light', 'dark']),
    }),
  }),
});

/** Validate an untrusted manifest payload; failures are `invalid-report` errors with a precise path. */
export function parseManifest(input: unknown): Manifest {
  return parseWith(ManifestSchema, input, 'manifest');
}
