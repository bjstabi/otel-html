import type { Manifest, ManifestChunk } from '../../format/manifest.js';
import type { TraceId } from '../../model/ids.js';
import type { LogRollups } from '../../rollups/log-rollups.js';
import { CHUNK_LRU_SIZE, Lru, SignalChunks, scanChunks } from './chunk-window.js';
import type { LogStrategy } from './data-source.js';
import { epochOf, type TraceIndex } from './load.js';
import { loadLogChunk, logNotFound } from './log-load.js';
import {
  byTimeThenRef,
  checkSurroundingCount,
  type LogEntry,
  type LogQuery,
  LogQueryRun,
  type LogRef,
  type LogRow,
  refParts,
  surroundingIn,
} from './log-query.js';
import { throwIfAborted } from './query-common.js';
import type { ScriptLoader } from './script-loader.js';

/** Neighbor chunks (wholly before, or wholly after, the log) Surrounding logs reads on each side before it says partial. */
export const SURROUNDING_CHUNKS_PER_SIDE = 4;
/** Other chunks spanning the log's time that Surrounding logs reads; with the sides' budgets this caps the total. */
const SURROUNDING_OVERLAP_CHUNKS = 4;

type Side = 'before' | 'after' | 'overlap';

/**
 * Newest first (the Logs Explorer default) visits chunks by end time descending, each one whole, so a scan cut
 * short by the cap lists the newest logs rather than the oldest ones reversed.
 */
function newestFirst(q: LogQuery): boolean {
  return q.sort.column === 'time' && q.sort.dir === 'desc';
}

/** Scan log chunks on demand, never holding more than `CHUNK_LRU_SIZE` decoded chunks (an LRU of its own). */
export function createWindowedLogSource(
  loader: ScriptLoader,
  manifest: Manifest,
  rollups: () => Promise<LogRollups>,
  index: TraceIndex,
): LogStrategy {
  const epoch = epochOf(manifest);
  // Rows a scan collects before it stops: the report's own `viewer.listCap` setting (default 10 000).
  const cap = manifest.config.viewer.listCap;
  const chunks = new SignalChunks(manifest, 'logs');
  const cache = new Lru<number, LogEntry[]>(CHUNK_LRU_SIZE);
  const chunkEntries = (c: ManifestChunk): Promise<LogEntry[]> =>
    cache.get(c.n, async () => (await loadLogChunk(loader, c, epoch)).entries);

  /** The log's chunk (fails fast when the manifest has none by that number) and the log itself. */
  const locate = async (ref: LogRef): Promise<{ chunk: ManifestChunk; entries: LogEntry[]; log: LogRow }> => {
    const { n, i } = refParts(ref);
    const chunk = chunks.byN(n);
    if (chunk === undefined) throw logNotFound(ref);
    const entries = await chunkEntries(chunk);
    const log = entries[i]?.row;
    if (log === undefined) throw logNotFound(ref);
    return { chunk, entries, log };
  };

  return {
    async queryLogs(q, onProgress, signal) {
      const run = new LogQueryRun(q, signal);
      const found = chunks.targets(q);
      const { unfiltered } = found;
      // A query restricted to one trace reads that trace's chunks (the index lists them all), not the whole window.
      const traceChunks =
        q.traceId == null ? null : chunks.listed((await index.entry(q.traceId))?.logChunks ?? []);
      const targets =
        traceChunks === null
          ? found.targets
          : found.targets.filter((c) => traceChunks.some((t) => t.n === c.n));
      // Traces-mode aggregates cover trace-bearing logs only, so the all-logs rollup does not stand in for them.
      const landing = unfiltered && q.mode !== 'traces' ? await rollups() : null;
      if (landing !== null && q.mode === 'patterns') {
        // The writer clustered every log: the unfiltered patterns are exact without a scan.
        throwIfAborted(signal);
        return {
          ...run.patternsOf(landing.patterns),
          matched: manifest.totals.logs,
          facets: landing.facets,
          buckets: landing.buckets,
          partial: null,
        };
      }
      const newest = newestFirst(q);
      const { partial } = await scanChunks({
        targets: newest ? [...targets].sort((a, b) => b.end - a.end || b.n - a.n) : targets,
        total: traceChunks === null ? chunks.ordered.length : traceChunks.length,
        entries: chunkEntries,
        run,
        cap,
        // Traces mode finishes the chunk it is in, so the traces it matched are seen whole within it; newest first
        // does too, because rows within a chunk are not in time order and the newest may come last.
        finishChunk: q.mode === 'traces' || newest,
        onProgress,
        signal,
      });
      const result = run.finish(partial);
      if (landing === null || result.mode !== 'logs') return result;
      // With nothing to filter on, the list is the head of the whole run; the aggregates and the size are the run's own.
      return {
        ...result,
        facets: landing.facets,
        buckets: landing.buckets,
        total: manifest.totals.logs,
        matched: manifest.totals.logs,
      };
    },

    async getLog(ref) {
      return (await locate(ref)).log;
    },

    async traceLogs(traceId: TraceId, signal) {
      const entry = await index.entry(traceId);
      if (entry === null) return [];
      const perChunk = await Promise.all(chunks.listed(entry.logChunks).map((c) => chunkEntries(c)));
      throwIfAborted(signal);
      return perChunk
        .flat()
        .flatMap((e) => (e.row.log.traceId === traceId ? [e.row] : []))
        .sort(byTimeThenRef);
    },

    async surroundingLogs(ref, n) {
      checkSurroundingCount(n);
      const { chunk, entries, log } = await locate(ref);
      const loaded = new Set([chunk.n]);
      // Only the `n` nearest on each side are kept, so each step sorts those plus one chunk's rows, not all loaded rows.
      let near = surroundingIn(
        log,
        entries.map((e) => e.row),
        n,
      );
      const sideOf = (c: ManifestChunk): Side =>
        c.end < log.time ? 'before' : c.start > log.time ? 'after' : 'overlap';
      const gap = (c: ManifestChunk): number =>
        c.end < log.time ? log.time - c.end : c.start > log.time ? c.start - log.time : 0;
      const left: Record<Side, number> = {
        before: SURROUNDING_CHUNKS_PER_SIDE,
        after: SURROUNDING_CHUNKS_PER_SIDE,
        overlap: SURROUNDING_OVERLAP_CHUNKS,
      };
      /** Unread chunks that could hold a log nearer than the `n` found so far on a side, nearest to the log first. */
      const pending = (): ManifestChunk[] => {
        if (n === 0) return [];
        const { before, after } = near;
        // A side holding `n` reaches only as far as its farthest one; a side short of `n` reaches without bound.
        const lo = before.length >= n ? (before[0]?.time ?? -Infinity) : -Infinity;
        const hi = after.length >= n ? (after[after.length - 1]?.time ?? Infinity) : Infinity;
        return chunks.ordered
          .filter((c) => !loaded.has(c.n) && c.end >= lo && c.start <= hi)
          .sort((a, b) => gap(a) - gap(b));
      };
      // Chunks can overlap in time, so the next chunks by start time are not enough: read every chunk that could
      // still hold a nearer log. Each side reads at most its own budget of chunks wholly before (or after) the log, and
      // chunks spanning the log time have a budget of their own, so one side never uses up the other's reads. A
      // chunk left unread for want of budget makes the answer partial.
      for (;;) {
        const next = pending().find((c) => left[sideOf(c)] > 0);
        if (next === undefined) break;
        left[sideOf(next)]--;
        loaded.add(next.n);
        near = surroundingIn(
          log,
          [...near.before, ...near.after, ...(await chunkEntries(next)).map((e) => e.row)],
          n,
        );
      }
      return { ...near, log, partial: pending().length > 0 };
    },
  };
}
