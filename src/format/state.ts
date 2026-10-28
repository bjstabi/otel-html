import { z } from 'zod';
import type { JsonValue } from './columns.js';
import type { SIGNALS } from './paths.js';
import { type TraceShard, TraceShardSchema } from './trace-shard.js';
import { parseWith } from './validate.js';

/**
 * Serialized rollups: per-signal (or per-rollup) JSON values. Permissive on purpose: the rollup
 * implementations own their shape. The writer's `serializeRollups` returns this type.
 */
export type SerializedRollups = Record<string, JsonValue>;

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const SerializedRollupsSchema: z.ZodType<SerializedRollups> = z.record(z.string(), JsonValueSchema);

export interface SessionState {
  formatVersion: 1;
  otelHtmlVersion: string;
  epochUnixNano: string | null;
  nextChunk: Record<(typeof SIGNALS)[number], number>;
  rollups: SerializedRollups;
  dedupe: string[];
  /** The whole trace index by shard, so a crash never leaves it ahead of the committed manifest. */
  traceIndex: Record<string, TraceShard>;
  /** The metric stream normalizer's state (cumulative streams); its owner validates the shape. */
  metricStreams: unknown;
  /** Next segment number per metric id. */
  nextSegment: Record<string, number>;
}

const nonNegInt = z.number().int().nonnegative();

export const SessionStateSchema: z.ZodType<SessionState> = z.strictObject({
  formatVersion: z.literal(1),
  otelHtmlVersion: z.string(),
  epochUnixNano: z
    .string()
    .regex(/^[0-9]+$/, 'decimal nanoseconds')
    .nullable(),
  nextChunk: z.strictObject({ spans: nonNegInt, logs: nonNegInt, metrics: nonNegInt }),
  rollups: SerializedRollupsSchema,
  dedupe: z.array(z.string()),
  traceIndex: z.record(z.string().regex(/^[0-9a-f]{2}$/, 'two lowercase hex chars'), TraceShardSchema),
  metricStreams: z.unknown().default({ keys: [], times: [], lasts: [], seriesKeys: [], seriesTimes: [] }),
  nextSegment: z.record(z.string().regex(/^(0|[1-9][0-9]*)$/, 'a metric id'), nonNegInt).default({}),
});

export function parseSessionState(input: unknown): SessionState {
  return parseWith(SessionStateSchema, input, 'state');
}
