import type { Manifest, ManifestChunk } from '../../format/manifest.js';
import { chunkKey } from '../../format/paths.js';
import type { TraceId } from '../../model/ids.js';
import type { StrategySource } from './data-source.js';
import { epochOf, loadSpanChunk, loadTraceEntry } from './load.js';
import type { ScriptLoader } from './script-loader.js';
import { type SpanEntry, SpanQueryRun, throwIfAborted } from './span-query.js';
import { assembleTrace, traceNotFound } from './trace-detail.js';

/** Decoded span chunks kept in memory by the windowed strategy (least recently used are dropped). */
export const CHUNK_LRU_SIZE = 8;

function overlaps(c: ManifestChunk, start: number, end: number): boolean {
  return c.end >= start && c.start <= end;
}

/** Scan span chunks on demand, never holding more than `CHUNK_LRU_SIZE` decoded chunks. */
export function createWindowedSource(loader: ScriptLoader, manifest: Manifest): StrategySource {
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
      for (const c of targets) {
        throwIfAborted(signal);
        const entries = await chunkEntries(c);
        for (const e of entries) {
          if (run.matches >= cap) break;
          run.visit(e);
        }
        scanned++;
        onProgress?.(scanned, spanChunks.length);
        if (run.matches >= cap) break;
      }
      // Exact only when every chunk was looked at and the cap did not cut the scan short.
      const exact = scanned === spanChunks.length && run.matches < cap;
      const result = run.finish(exact ? null : { scanned, total: spanChunks.length });
      // With nothing to filter on, the list is the head of the whole run, and the manifest knows its size.
      return unfiltered ? { ...result, total: manifest.totals.spans } : result;
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
