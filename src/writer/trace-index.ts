import { shardOf } from '../format/paths.js';
import type { TraceEntry, TraceShard } from '../format/trace-shard.js';
import type { TraceId } from '../model/ids.js';
import type { LogRecordRecord, ResourceRecord, SpanRecord } from '../model/records.js';
import { logTime, StatusCode } from '../model/records.js';
import { resourceName, serviceName } from '../semconv/resource-name.js';

/** The registration key of the chunk a span was written to (`chunks/spans/000012`). */
export type ChunkRef = string;

// Every new entry starts on this one array (an empty `[]` that has been pushed to costs 184 B, a concat result
// 56 B). It is frozen so a stray in-place push throws instead of corrupting every entry: chunk lists are only
// ever replaced (`concat`), which also lets a checkpoint hold an entry while the writer keeps appending.
const NO_CHUNKS = Object.freeze([]) as unknown as string[];

const DEFAULT_INTERN_CAP = 10_000;

function emptyEntry(start: number, end: number): TraceEntry {
  return { chunks: NO_CHUNKS, logChunks: NO_CHUNKS, start, end, spans: 0, logs: 0, errors: 0, root: null };
}

/**
 * trace_id to chunk refs plus a small summary, sharded by the first two hex characters of the id. Spans of
 * one trace may arrive far apart, in different chunks or sessions: entries only ever grow, and the root is
 * `null` until the span without a parent is seen.
 */
export class TraceIndex {
  readonly #shards = new Map<string, Map<string, TraceEntry>>();
  readonly #dirty = new Set<string>();
  // Root service/name/resource strings repeat across hundreds of thousands of traces. The cap bounds the table
  // when names are unbounded (e.g. ids in span names); past it strings are stored as they are.
  readonly #interned = new Map<string, string>();
  readonly #internCap: number;

  constructor(options: { internCap?: number } = {}) {
    this.#internCap = options.internCap ?? DEFAULT_INTERN_CAP;
  }

  #intern(s: string): string {
    const known = this.#interned.get(s);
    if (known !== undefined) return known;
    if (this.#interned.size < this.#internCap) this.#interned.set(s, s);
    return s;
  }

  #entry(traceId: TraceId): TraceEntry | undefined {
    return this.#shards.get(shardOf(traceId))?.get(traceId);
  }

  #create(traceId: TraceId, entry: TraceEntry): TraceEntry {
    const shard = shardOf(traceId);
    let traces = this.#shards.get(shard);
    if (traces === undefined) {
      traces = new Map();
      this.#shards.set(shard, traces);
    }
    traces.set(traceId, entry);
    return entry;
  }

  add(span: SpanRecord, chunk: ChunkRef, resource: ResourceRecord): void {
    const e = this.#entry(span.traceId) ?? this.#create(span.traceId, emptyEntry(span.start, span.end));
    if (e.chunks[e.chunks.length - 1] !== chunk) e.chunks = e.chunks.concat(chunk);
    // Timing is span-defined: an entry that so far only knew logs takes the first span's extent outright.
    e.start = e.spans === 0 ? span.start : Math.min(e.start, span.start);
    e.end = e.spans === 0 ? span.end : Math.max(e.end, span.end);
    e.spans++;
    if (span.status.code === StatusCode.ERROR) e.errors++;
    if (span.parentSpanId === null && e.root === null) {
      e.root = {
        service: this.#intern(serviceName(resource)),
        name: this.#intern(span.name),
        resource: this.#intern(resourceName(span)),
      };
    }
    this.#dirty.add(shardOf(span.traceId));
  }

  /**
   * Record a log that carries a trace id. The entry is created when missing (a log can precede, or never
   * have, spans); its timing only follows logs while no span has been seen.
   */
  addLog(log: LogRecordRecord, chunk: ChunkRef): void {
    if (log.traceId === null) return;
    const t = logTime(log);
    const e = this.#entry(log.traceId) ?? this.#create(log.traceId, emptyEntry(t, t));
    if (e.logChunks[e.logChunks.length - 1] !== chunk) e.logChunks = e.logChunks.concat(chunk);
    if (e.spans === 0) {
      e.start = Math.min(e.start, t);
      e.end = Math.max(e.end, t);
    }
    e.logs++;
    this.#dirty.add(shardOf(log.traceId));
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

  /**
   * The shard's live entries as a plain object, for serializing at once: no copy of entries or arrays (chunk lists
   * are only ever replaced, never mutated), so it must not be kept across further adds.
   */
  shardView(shard: string): Readonly<TraceShard> {
    return Object.fromEntries(this.#shards.get(shard) ?? []);
  }

  shardPayload(shard: string): TraceShard {
    const out: TraceShard = {};
    for (const [id, e] of this.#shards.get(shard) ?? [])
      out[id] = { ...e, chunks: [...e.chunks], logChunks: [...e.logChunks] };
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
      for (const [id, e] of Object.entries(entries))
        traces.set(id, {
          ...e,
          chunks: e.chunks.length === 0 ? NO_CHUNKS : [...e.chunks],
          logChunks: e.logChunks.length === 0 ? NO_CHUNKS : [...e.logChunks],
          root:
            e.root === null
              ? null
              : {
                  service: idx.#intern(e.root.service),
                  name: idx.#intern(e.root.name),
                  resource: idx.#intern(e.root.resource),
                },
        });
      idx.#shards.set(shard, traces);
    }
    idx.markAllDirty();
    return idx;
  }
}
