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
  sameStream,
  surroundingIn,
} from './log-query.js';
import { throwIfAborted } from './query-common.js';
import type { ScriptLoader } from './script-loader.js';

/** Neighbor chunks (by start time) Surrounding logs reads on each side of the log's own chunk before it says partial. */
export const SURROUNDING_CHUNKS_PER_SIDE = 4;

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
      const { targets, unfiltered } = chunks.targets(q);
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
        total: chunks.ordered.length,
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
      const at = chunks.ordered.indexOf(chunk);
      const rows = entries.map((e) => e.row);
      const found = (side: -1 | 1): number =>
        rows.filter((r) => sameStream(log, r) && Math.sign(byTimeThenRef(r, log)) === side).length;
      /** Reads neighbor chunks on one side until it holds `n` there; true when it stopped at the cap with more left. */
      const extend = async (side: -1 | 1): Promise<boolean> => {
        for (let k = 1; k <= SURROUNDING_CHUNKS_PER_SIDE; k++) {
          if (found(side) >= n) return false;
          const c = chunks.ordered[at + side * k];
          if (c === undefined) return false;
          for (const e of await chunkEntries(c)) rows.push(e.row);
        }
        return found(side) < n && chunks.ordered[at + side * (SURROUNDING_CHUNKS_PER_SIDE + 1)] !== undefined;
      };
      const partialBefore = await extend(-1);
      const partialAfter = await extend(1);
      return { ...surroundingIn(log, rows, n), log, partial: partialBefore || partialAfter };
    },
  };
}
