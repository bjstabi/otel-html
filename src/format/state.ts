import { z } from 'zod';
import { OtelHtmlError } from '../model/errors.js';
import type { JsonValue } from './columns.js';
import type { Table } from './parquet/schema.js';
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

const SerializedRollupsSchema: z.ZodType<SerializedRollups> = z.record(z.string(), JsonValueSchema);

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
  metricStreams: z
    .unknown()
    .default({ keys: [], times: [], lasts: [], seriesKeys: [], seriesTimes: [], folded: [] }),
  nextSegment: z.record(z.string().regex(/^(0|[1-9][0-9]*)$/, 'a metric id'), nonNegInt).default({}),
});

export function parseSessionState(input: unknown): SessionState {
  return parseWith(SessionStateSchema, input, 'state');
}

/** The format-4 writer's checkpoint: partitions replace chunks, so there are no chunk counters, rollups or trace index. */
export interface SessionStateV2 {
  formatVersion: 2;
  otelHtmlVersion: string;
  epochUnixNano: string | null;
  nextPartition: number;
  /** Partitions written since open that `close()` compacts: strictly increasing, each below `nextPartition`. */
  flushPartitions: number[];
  dedupe: string[];
  /** The metric stream normalizer's state; `null` when it has none. Its owner validates the shape. */
  metricStreams: unknown;
  /** The drain log-template state; `null` when it has none. Its owner validates the shape. */
  drain: unknown;
  statisticsKeys: Record<Table, string[]>;
}

// Required but opaque: any JSON value, `null` for none, never absent.
const opaque = z.custom<unknown>((v) => v !== undefined, 'a JSON value (null when there is none)');

const SessionStateV2Schema: z.ZodType<SessionStateV2> = z
  .strictObject({
    formatVersion: z.literal(2),
    otelHtmlVersion: z.string(),
    epochUnixNano: z
      .string()
      .regex(/^[0-9]+$/, 'decimal nanoseconds')
      .nullable(),
    nextPartition: nonNegInt,
    flushPartitions: z.array(nonNegInt),
    dedupe: z.array(z.string()),
    metricStreams: opaque,
    drain: opaque,
    statisticsKeys: z.strictObject({
      spans: z.array(z.string()),
      logs: z.array(z.string()),
      points: z.array(z.string()),
      traces: z.array(z.string()),
      patterns: z.array(z.string()),
    }),
  })
  .superRefine((s, ctx) => {
    s.flushPartitions.forEach((n, i) => {
      const prev = s.flushPartitions[i - 1];
      if (prev !== undefined && n <= prev) {
        ctx.addIssue({ code: 'custom', path: ['flushPartitions', i], message: `a number above ${prev}` });
      } else if (n >= s.nextPartition) {
        ctx.addIssue({
          code: 'custom',
          path: ['flushPartitions', i],
          message: `a number below nextPartition (${s.nextPartition})`,
        });
      }
    });
  });

export type AnySessionState = SessionState | SessionStateV2;

/** Dispatch on `formatVersion`: 1 is a chunk-format state, 2 a partition-format state. */
export function parseAnySessionState(input: unknown): AnySessionState {
  const v =
    typeof input === 'object' && input !== null && 'formatVersion' in input ? input.formatVersion : undefined;
  if (v === 1) return parseSessionState(input);
  if (v === 2) return parseWith(SessionStateV2Schema, input, 'state');
  throw new OtelHtmlError('invalid-report', {
    path: 'state.formatVersion',
    expected: '1 | 2',
    actual: JSON.stringify(v) ?? 'nothing (missing)',
  });
}
