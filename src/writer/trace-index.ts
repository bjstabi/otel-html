import { shardOf } from '../format/paths.js';
import type { TraceEntry, TraceShard } from '../format/trace-shard.js';
import type { ResourceRecord, SpanRecord } from '../model/records.js';
import { StatusCode } from '../model/records.js';
import { resourceName, serviceName } from '../semconv/resource-name.js';

/** The registration key of the chunk a span was written to (`chunks/spans/000012`). */
export type ChunkRef = string;

/**
 * trace_id to chunk refs plus a small summary, sharded by the first two hex characters of the id. Spans of
 * one trace may arrive far apart, in different chunks or sessions: entries only ever grow, and the root is
 * `null` until the span without a parent is seen.
 */
export class TraceIndex {
  readonly #shards = new Map<string, Map<string, TraceEntry>>();
  readonly #dirty = new Set<string>();

  add(span: SpanRecord, chunk: ChunkRef, resource: ResourceRecord): void {
    const shard = shardOf(span.traceId);
    let traces = this.#shards.get(shard);
    if (traces === undefined) {
      traces = new Map();
      this.#shards.set(shard, traces);
    }
    let e = traces.get(span.traceId);
    if (e === undefined) {
      e = { chunks: [], start: span.start, end: span.end, spans: 0, errors: 0, root: null };
      traces.set(span.traceId, e);
    }
    if (e.chunks[e.chunks.length - 1] !== chunk) e.chunks.push(chunk);
    e.start = Math.min(e.start, span.start);
    e.end = Math.max(e.end, span.end);
    e.spans++;
    if (span.status.code === StatusCode.ERROR) e.errors++;
    if (span.parentSpanId === null && e.root === null) {
      e.root = { service: serviceName(resource), name: span.name, resource: resourceName(span) };
    }
    this.#dirty.add(shard);
  }

  /** Shards changed since the last `clearDirty`, sorted. */
  dirtyShards(): string[] {
    return [...this.#dirty].sort();
  }

  clearDirty(): void {
    this.#dirty.clear();
  }

  markAllDirty(): void {
    for (const s of this.#shards.keys()) this.#dirty.add(s);
  }

  /** Every shard that has at least one trace, sorted. */
  shards(): string[] {
    return [...this.#shards.keys()].sort();
  }

  shardPayload(shard: string): TraceShard {
    const out: TraceShard = {};
    for (const [id, e] of this.#shards.get(shard) ?? []) out[id] = { ...e, chunks: [...e.chunks] };
    return out;
  }

  toJSON(): Record<string, TraceShard> {
    return Object.fromEntries(this.shards().map((s) => [s, this.shardPayload(s)]));
  }

  /** Rebuild from `toJSON` output (already validated by the state schema). All shards start dirty. */
  static load(shards: Readonly<Record<string, TraceShard>>): TraceIndex {
    const idx = new TraceIndex();
    for (const [shard, entries] of Object.entries(shards)) {
      const traces = new Map<string, TraceEntry>();
      for (const [id, e] of Object.entries(entries)) traces.set(id, { ...e, chunks: [...e.chunks] });
      idx.#shards.set(shard, traces);
    }
    idx.markAllDirty();
    return idx;
  }
}
