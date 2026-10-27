import type { Manifest, ManifestChunk } from '../../format/manifest.js';
import { chunkKey, type Signal } from '../../format/paths.js';
import { throwIfAborted } from './query-common.js';
import type { TimeWindow } from './span-query.js';

/** Decoded chunks each windowed strategy keeps in memory (least recently used are dropped). */
export const CHUNK_LRU_SIZE = 8;

/**
 * A bounded cache of loaded values, least recently used dropped first. A value is inserted only once its load
 * resolves, so an aborted or failed load changes nothing; concurrent requests for one key share one load.
 */
export class Lru<K, V extends object | null> {
  readonly #size: number;
  readonly #cache = new Map<K, V>();
  readonly #inFlight = new Map<K, Promise<V>>();

  constructor(size: number) {
    this.#size = size;
  }

  get(key: K, load: () => Promise<V>): Promise<V> {
    const hit = this.#cache.get(key);
    if (hit !== undefined) {
      this.#touch(key, hit);
      return Promise.resolve(hit);
    }
    let pending = this.#inFlight.get(key);
    if (pending === undefined) {
      pending = load()
        .then((v) => {
          this.#touch(key, v);
          return v;
        })
        .finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, pending);
    }
    return pending;
  }

  #touch(key: K, v: V): void {
    this.#cache.delete(key);
    this.#cache.set(key, v);
    for (const old of this.#cache.keys()) {
      if (this.#cache.size <= this.#size) break;
      this.#cache.delete(old);
    }
  }
}

/** One signal's manifest chunks ordered by start time (then number), with lookups by key and number. */
export class SignalChunks {
  readonly ordered: readonly ManifestChunk[];
  readonly #byKey: Map<string, ManifestChunk>;
  readonly #byN: Map<number, ManifestChunk>;

  constructor(manifest: Manifest, signal: Signal) {
    this.ordered = manifest.chunks
      .filter((c) => c.signal === signal)
      .sort((a, b) => a.start - b.start || a.n - b.n);
    this.#byKey = new Map(this.ordered.map((c) => [chunkKey(signal, c.n), c]));
    this.#byN = new Map(this.ordered.map((c) => [c.n, c]));
  }

  byN(n: number): ManifestChunk | undefined {
    return this.#byN.get(n);
  }

  /** The manifest-listed chunks among `keys`, deduplicated. A trace shard can be ahead of the manifest after a crash. */
  listed(keys: readonly string[]): ManifestChunk[] {
    return [...new Set(keys)].flatMap((key) => {
      const c = this.#byKey.get(key);
      return c === undefined ? [] : [c];
    });
  }

  /**
   * The chunks a scan visits: those overlapping the window, or all of them for "scan entire run" or no window.
   * `unfiltered` is a query with nothing to filter on, whose aggregates are the unfiltered rollups.
   */
  targets(q: { condition: string | null; text: string; window: TimeWindow | null; scanAll: boolean }): {
    targets: readonly ManifestChunk[];
    unfiltered: boolean;
  } {
    const window = q.scanAll ? null : q.window;
    const unfiltered = q.condition === null && q.text === '' && window === null;
    if (window === null) return { targets: this.ordered, unfiltered };
    const { start, end } = window;
    return { targets: this.ordered.filter((c) => c.end >= start && c.start <= end), unfiltered };
  }
}

export interface ScanRun<E> {
  readonly units: number;
  visit(e: E): void;
}

/**
 * Visit the target chunks in order until the run reaches `cap` units. With `finishChunk` a chunk is always
 * visited whole (traces modes, so a matched trace is seen whole within it). `partial` is null only when every
 * chunk of the signal was visited and the cap did not cut the scan short.
 */
export async function scanChunks<E>(opts: {
  targets: readonly ManifestChunk[];
  total: number;
  entries: (c: ManifestChunk) => Promise<readonly E[]>;
  run: ScanRun<E>;
  cap: number;
  finishChunk: boolean;
  onProgress: ((scanned: number, total: number) => void) | undefined;
  signal: AbortSignal | undefined;
}): Promise<{ scanned: ReadonlySet<number>; partial: { scanned: number; total: number } | null }> {
  const { run, cap, total } = opts;
  const scanned = new Set<number>();
  for (const c of opts.targets) {
    throwIfAborted(opts.signal);
    const entries = await opts.entries(c);
    for (const e of entries) {
      if (!opts.finishChunk && run.units >= cap) break;
      run.visit(e);
    }
    scanned.add(c.n);
    opts.onProgress?.(scanned.size, total);
    if (run.units >= cap) break;
  }
  const exact = scanned.size === total && run.units < cap;
  return { scanned, partial: exact ? null : { scanned: scanned.size, total } };
}
