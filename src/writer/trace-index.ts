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
const NO_CHUNKS: readonly string[] = Object.freeze([]);

const DEFAULT_INTERN_CAP = 10_000;

type TraceRoot = NonNullable<TraceEntry['root']>;

function emptyEntry(start: number, end: number): TraceEntry {
  return { chunks: NO_CHUNKS, logChunks: NO_CHUNKS, start, end, spans: 0, logs: 0, errors: 0, root: null };
}

/**
 * A checkpoint's frozen view of the index: per shard, the entry map as it was, holding the very entry objects the
 * index had at that moment. While the index holds it, an entry is replaced by a copy before it changes, so these
 * objects stay as they were (see `TraceIndex.snapshot`).
 */
export interface TraceIndexSnapshot {
  /** Shards that had changed since the previous snapshot, sorted. */
  readonly dirty: readonly string[];
  /** Every shard with a trace, sorted. */
  readonly shardNames: readonly string[];
  /** The shard's entries as they were; read only. */
  entries(shard: string): ReadonlyMap<string, TraceEntry>;
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
  #held: Map<string, Map<string, TraceEntry>> | null = null;
  // Shards whose live map is still the very map the held snapshot reads (see `#shardForWrite`).
  readonly #shared = new Set<string>();
  readonly #roots = new Map<string, Map<string, Map<string, TraceRoot>>>();
  #rootCount = 0;
  // The last one-element chunk list handed out per list kind. The chunk being written only changes on a cut, so
  // nearly every first chunk of a new entry equals the previous one.
  #lastSpanList: readonly string[] = NO_CHUNKS;
  #lastLogList: readonly string[] = NO_CHUNKS;
  readonly #internCap: number;

  constructor(options: { internCap?: number } = {}) {
    this.#internCap = options.internCap ?? DEFAULT_INTERN_CAP;
  }

  // Roots repeat as much as their strings (a few distinct ones across hundreds of thousands of traces), and an
  // object costs more heap than its three string fields point at. One frozen root is shared by every trace with the
  // same three strings; frozen, because an entry copy made for a snapshot shares it too, so it must never change.
  // Bounded by the same cap; past it a fresh frozen root is returned.
  #sharedRoot(service: string, name: string, resource: string): TraceRoot {
    // Nested maps, not one joined key: OTLP strings may hold any character, so no separator keeps two triples apart,
    // and a lookup allocates no key string.
    const byName = this.#roots.get(service);
    const byResource = byName?.get(name);
    const known = byResource?.get(resource);
    if (known !== undefined) return known;
    const root = Object.freeze({
      service: this.#intern(service),
      name: this.#intern(name),
      resource: this.#intern(resource),
    });
    if (this.#rootCount < this.#internCap) {
      this.#rootCount++;
      const n = byName ?? new Map<string, Map<string, TraceRoot>>();
      if (byName === undefined) this.#roots.set(service, n);
      const r = byResource ?? new Map<string, TraceRoot>();
      if (byResource === undefined) n.set(name, r);
      r.set(resource, root);
    }
    return root;
  }

  #intern(s: string): string {
    const known = this.#interned.get(s);
    if (known !== undefined) return known;
    if (this.#interned.size < this.#internCap) this.#interned.set(s, s);
    return s;
  }

  /**
   * The live map of a shard, made ready for a change. A shard the held snapshot still shares by map is copied
   * first, so the snapshot keeps the original map; the copy is paid once per shard per snapshot, by the first
   * change, instead of for every shard inside the queue when the snapshot is taken.
   */
  #shardForWrite(shard: string): Map<string, TraceEntry> {
    let traces = this.#shards.get(shard);
    if (traces === undefined) {
      // A shard created while a snapshot is held is not in it, so nothing shares this map.
      traces = new Map();
      this.#shards.set(shard, traces);
    } else if (this.#shared.delete(shard)) {
      traces = new Map(traces);
      this.#shards.set(shard, traces);
    }
    return traces;
  }

  /**
   * The entry to change. An entry the held snapshot shares is replaced in the live map by a copy first: that
   * keeps what the snapshot's writer reads as it was, at the cost of one lookup per change while a snapshot is held.
   */
  #writable(traceId: TraceId, created: () => TraceEntry): TraceEntry {
    const shard = shardOf(traceId);
    const traces = this.#shardForWrite(shard);
    const e = traces.get(traceId);
    if (e === undefined) {
      const fresh = created();
      traces.set(traceId, fresh);
      return fresh;
    }
    if (this.#held?.get(shard)?.get(traceId) !== e) return e;
    const copy = { ...e };
    traces.set(traceId, copy);
    return copy;
  }

  add(span: SpanRecord, chunk: ChunkRef, resource: ResourceRecord): void {
    const e = this.#writable(span.traceId, () => emptyEntry(span.start, span.end));
    if (e.chunks[e.chunks.length - 1] !== chunk) {
      if (e.chunks.length === 0) {
        if (this.#lastSpanList[0] !== chunk) this.#lastSpanList = Object.freeze([chunk]);
        e.chunks = this.#lastSpanList;
      } else e.chunks = e.chunks.concat(chunk);
    }
    // Timing is span-defined: an entry that so far only knew logs takes the first span's extent outright.
    e.start = e.spans === 0 ? span.start : Math.min(e.start, span.start);
    e.end = e.spans === 0 ? span.end : Math.max(e.end, span.end);
    e.spans++;
    if (span.status.code === StatusCode.ERROR) e.errors++;
    if (span.parentSpanId === null && e.root === null) {
      e.root = this.#sharedRoot(serviceName(resource), span.name, resourceName(span));
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
    const e = this.#writable(log.traceId, () => emptyEntry(t, t));
    if (e.logChunks[e.logChunks.length - 1] !== chunk) {
      if (e.logChunks.length === 0) {
        if (this.#lastLogList[0] !== chunk) this.#lastLogList = Object.freeze([chunk]);
        e.logChunks = this.#lastLogList;
      } else e.logChunks = e.logChunks.concat(chunk);
    }
    if (e.spans === 0) {
      e.start = Math.min(e.start, t);
      e.end = Math.max(e.end, t);
    }
    e.logs++;
    this.#dirty.add(shardOf(log.traceId));
  }

  /** Shards changed since the last `snapshot`, sorted. */
  dirtyShards(): string[] {
    return [...this.#dirty].sort();
  }

  /** Mark shards changed again, when the checkpoint that took them from `snapshot` failed. */
  restoreDirty(shards: readonly string[]): void {
    for (const s of shards) this.#dirty.add(s);
  }

  markAllDirty(): void {
    for (const s of this.#shards.keys()) this.#dirty.add(s);
  }

  /** Every shard that has at least one trace, sorted. */
  shards(): string[] {
    return [...this.#shards.keys()].sort();
  }

  /**
   * Freeze the index for a checkpoint that writes while adds go on, and clear the dirty set. Costs O(shards): the
   * maps are shared and copied by the first change to each (`#shardForWrite`). Only one snapshot can be held;
   * `release` it when its writer is done (or has failed).
   */
  snapshot(): TraceIndexSnapshot {
    if (this.#held !== null) throw new Error('a trace index snapshot is already held');
    const held = new Map<string, Map<string, TraceEntry>>();
    for (const [shard, traces] of this.#shards) {
      held.set(shard, traces);
      this.#shared.add(shard);
    }
    this.#held = held;
    const dirty = this.dirtyShards();
    this.#dirty.clear();
    const shardNames = this.shards();
    return { dirty, shardNames, entries: (shard) => held.get(shard) ?? new Map() };
  }

  release(): void {
    this.#held = null;
    this.#shared.clear();
  }

  #loadList(chunks: readonly string[], kind: 'span' | 'log'): readonly string[] {
    if (chunks.length === 0) return NO_CHUNKS;
    if (chunks.length > 1) return [...chunks];
    const chunk = chunks[0] as string;
    const last = kind === 'span' ? this.#lastSpanList : this.#lastLogList;
    if (last[0] === chunk) return last;
    const list = Object.freeze([chunk]);
    if (kind === 'span') this.#lastSpanList = list;
    else this.#lastLogList = list;
    return list;
  }

  /** Rebuild from the state's `traceIndex` (already validated by the state schema). All shards start dirty. */
  static load(shards: Readonly<Record<string, TraceShard>>): TraceIndex {
    const idx = new TraceIndex();
    for (const [shard, entries] of Object.entries(shards)) {
      const traces = new Map<string, TraceEntry>();
      for (const [id, e] of Object.entries(entries))
        traces.set(id, {
          ...e,
          chunks: idx.#loadList(e.chunks, 'span'),
          logChunks: idx.#loadList(e.logChunks, 'log'),
          root: e.root === null ? null : idx.#sharedRoot(e.root.service, e.root.name, e.root.resource),
        });
      idx.#shards.set(shard, traces);
    }
    idx.markAllDirty();
    return idx;
  }
}
