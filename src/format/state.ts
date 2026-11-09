import { z } from 'zod';
import { OtelHtmlError } from '../model/errors.js';
import type { Table } from './parquet/columns.js';
import { describe, parseWith } from './validate.js';

const nonNegInt = z.number().int().nonnegative();

/** The writer's checkpoint: the partitions written, the dedupe set and the opaque states of the normalizer and drain. */
export interface SessionStateV2 {
  formatVersion: 2;
  otelHtmlVersion: string;
  epochUnixNano: string | null;
  nextPartition: number;
  /** Counts the state writes of the report (+1 each, across sessions); of two slots that match the manifest, the higher is newer. */
  checkpoint: number;
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
    checkpoint: nonNegInt,
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

/** Parses a state slot; a state of any other `formatVersion` (the chunk writer's was 1) is an invalid report. */
export function parseAnySessionState(input: unknown): SessionStateV2 {
  const v =
    typeof input === 'object' && input !== null && 'formatVersion' in input ? input.formatVersion : undefined;
  if (v === 2) return parseWith(SessionStateV2Schema, input, 'state');
  throw new OtelHtmlError('invalid-report', {
    path: 'state.formatVersion',
    expected: '2',
    actual: describe(typeof input === 'object' && input !== null ? v : input),
  });
}
