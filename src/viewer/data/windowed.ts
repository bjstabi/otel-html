import type { Manifest, ManifestChunk } from '../../format/manifest.js';
import { chunkKey, shardOf } from '../../format/paths.js';
import type { TraceShard } from '../../format/trace-shard.js';
import type { TraceId } from '../../model/ids.js';
import type { SpanRollups } from '../../rollups/span-rollups.js';
import type { StrategySource } from './data-source.js';
import { epochOf, loadSpanChunk, loadTraceEntry, loadTraceShard } from './load.js';
import type { ScriptLoader } from './script-loader.js';
import { type SpanEntry, SpanQueryRun, type TraceFacts, throwIfAborted } from './span-query.js';
import { assembleTrace, traceNotFound } from './trace-detail.js';

/** Decoded span chunks kept in memory by the windowed strategy (least recently used are dropped). */
export const CHUNK_LRU_SIZE = 8;

function overlaps(c: ManifestChunk, start: number, end: number): boolean {
  return c.end >= start && c.start <= end;
}

/** Scan span chunks on demand, never holding more than `CHUNK_LRU_SIZE` decoded chunks. */
export function createWindowedSource(
  loader: ScriptLoader,
  manifest: Manifest,
  rollups: SpanRollups,
): StrategySource {
  const epoch = epochOf(manifest);
  // Rows a scan collects before it stops: the report's own `viewer.listCap` setting (default 10 000).
  const cap = manifest.config.viewer.listCap;
  const spanChunks = manifest.chunks
    .filter((c) => c.signal === 'spans')
    .sort((a, b) => a.start - b.start || a.n - b.n);
  const byKey = new Map(spanChunks.map((c) => [chunkKey('spans', c.n), c]));
  // Least recently used first. A chunk is inserted only once fully decoded, so an aborted or failed load changes nothing.
  const cache = new Map<number, SpanEntry[]>();
  const inFlight = new Map<number, Promise<SpanEntry[]>>();

  const touch = (n: number, entries: SpanEntry[]): void => {
    cache.delete(n);
    cache.set(n, entries);
    for (const old of cache.keys()) {
      if (cache.size <= CHUNK_LRU_SIZE) break;
      cache.delete(old);
    }
  };

  const chunkEntries = (c: ManifestChunk): Promise<SpanEntry[]> => {
    const hit = cache.get(c.n);
    if (hit !== undefined) {
      touch(c.n, hit);
      return Promise.resolve(hit);
    }
    let pending = inFlight.get(c.n);
    if (pending === undefined) {
      pending = loadSpanChunk(loader, c, epoch)
        .then((l) => {
          touch(c.n, l.entries);
          return l.entries;
        })
        .finally(() => inFlight.delete(c.n));
      inFlight.set(c.n, pending);
    }
    return pending;
  };

  /** Whole-trace figures for every matched trace, from the manifest-listed trace shards (one load per shard). */
  const traceFacts = async (
    run: SpanQueryRun,
    scannedChunks: ReadonlySet<number>,
    signal: AbortSignal | undefined,
  ): Promise<Map<TraceId, TraceFacts>> => {
    const facts = new Map<TraceId, TraceFacts>();
    const shards = new Map<string, TraceShard | null>();
    for (const id of run.hitTraceIds()) {
      throwIfAborted(signal);
      const name = shardOf(id);
      if (!shards.has(name)) shards.set(name, await loadTraceShard(loader, manifest, name));
      const entry = shards.get(name)?.[id];
      if (entry === undefined) continue;
      const listed = [...new Set(entry.chunks)].flatMap((key) => {
        const c = byKey.get(key);
        return c === undefined ? [] : [c];
      });
      facts.set(id, {
        start: entry.start,
        end: entry.end,
        spans: entry.spans,
        errors: entry.errors,
        root: entry.root,
        complete: run.seenRows(id).length === entry.spans && listed.every((c) => scannedChunks.has(c.n)),
      });
    }
    return facts;
  };

  return {
    async querySpans(q, onProgress, signal) {
      const run = new SpanQueryRun(q, signal);
      const window = q.scanAll ? null : q.window;
      const unfiltered = q.condition === null && q.text === '' && window === null;
      let targets = spanChunks;
      if (!unfiltered && window !== null) {
        const { start, end } = window;
        targets = spanChunks.filter((c) => overlaps(c, start, end));
      }
      let scanned = 0;
      const scannedChunks = new Set<number>();
      for (const c of targets) {
        throwIfAborted(signal);
        const entries = await chunkEntries(c);
        for (const e of entries) {
          // Traces mode finishes the chunk it is in, so the traces it matched are seen whole within it.
          if (q.mode === 'spans' && run.units >= cap) break;
          run.visit(e);
        }
        scanned++;
        scannedChunks.add(c.n);
        onProgress?.(scanned, spanChunks.length);
        if (run.units >= cap) break;
      }
      // Exact only when every chunk was looked at and the cap did not cut the scan short.
      const exact = scanned === spanChunks.length && run.units < cap;
      const partial = exact ? null : { scanned, total: spanChunks.length };
      const facts = q.mode === 'traces' ? await traceFacts(run, scannedChunks, signal) : undefined;
      const result = run.finish(partial, facts === undefined ? undefined : (id) => facts.get(id));
      if (!unfiltered) return result;
      // With nothing to filter on, the list is the head of the whole run; the aggregates and the size are the run's own.
      const aggregates = { facets: rollups.facets, buckets: rollups.buckets, red: rollups.red };
      return q.mode === 'traces'
        ? { ...result, ...aggregates }
        : { ...result, ...aggregates, total: manifest.totals.spans };
    },

    async getTrace(traceId: TraceId) {
      const entry = await loadTraceEntry(loader, manifest, traceId);
      if (entry === null) throw traceNotFound(traceId);
      // After a crash the shard can reference chunks the manifest does not list yet: ignore those.
      const chunks = [...new Set(entry.chunks)].flatMap((key) => {
        const c = byKey.get(key);
        return c === undefined ? [] : [c];
      });
      const perChunk = await Promise.all(chunks.map((c) => chunkEntries(c)));
      return assembleTrace(
        traceId,
        perChunk.flat().filter((e) => e.row.span.traceId === traceId),
      );
    },
  };
}
