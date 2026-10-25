import { z } from 'zod';

/** A trace's summary in the trace index: which chunks hold its spans, plus enough to list it. */
export interface TraceEntry {
  /** Chunk registration keys (`chunks/spans/000012`), in the order the chunks were written. */
  chunks: string[];
  start: number;
  end: number;
  spans: number;
  errors: number;
  /** The span with no parent; null until it has been seen (orphans, in-flight and split traces). */
  root: { service: string; name: string; resource: string } | null;
}

/** One trace-index shard: trace id (32 lowercase hex) to entry. */
export type TraceShard = Record<string, TraceEntry>;

const nonNegInt = z.number().int().nonnegative();

const TraceEntrySchema: z.ZodType<TraceEntry> = z.strictObject({
  chunks: z.array(z.string().regex(/^chunks\/spans\/[0-9]{6,}$/, 'a chunk key like chunks/spans/000000')),
  start: z.number().int(),
  end: z.number().int(),
  spans: nonNegInt,
  errors: nonNegInt,
  root: z.strictObject({ service: z.string(), name: z.string(), resource: z.string() }).nullable(),
});

export const TraceShardSchema: z.ZodType<TraceShard> = z.record(
  z.string().regex(/^[0-9a-f]{32}$/, '32 lowercase hex chars'),
  TraceEntrySchema,
);
