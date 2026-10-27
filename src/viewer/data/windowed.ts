import type { Manifest, ManifestChunk } from '../../format/manifest.js';
import { shardOf } from '../../format/paths.js';
import type { TraceShard } from '../../format/trace-shard.js';
import type { TraceId } from '../../model/ids.js';
import type { SpanRollups } from '../../rollups/span-rollups.js';
import { CHUNK_LRU_SIZE, Lru, SignalChunks, scanChunks } from './chunk-window.js';
import type { SpanStrategy } from './data-source.js';
import { epochOf, loadSpanChunk, type TraceIndex } from './load.js';
import { throwIfAborted } from './query-common.js';
import type { ScriptLoader } from './script-loader.js';
import { type SpanEntry, SpanQueryRun, type TraceFacts } from './span-query.js';
import { assembleTrace, traceNotFound } from './trace-detail.js';

export { CHUNK_LRU_SIZE } from './chunk-window.js';

/** Scan span chunks on demand, never holding more than `CHUNK_LRU_SIZE` decoded chunks. */
export function createWindowedSource(
  loader: ScriptLoader,
  manifest: Manifest,
  rollups: SpanRollups,
  index: TraceIndex,
): SpanStrategy {
  const epoch = epochOf(manifest);
  // Rows a scan collects before it stops: the report's own `viewer.listCap` setting (default 10 000).
  const cap = manifest.config.viewer.listCap;
  const chunks = new SignalChunks(manifest, 'spans');
  const cache = new Lru<number, SpanEntry[]>(CHUNK_LRU_SIZE);
  const chunkEntries = (c: ManifestChunk): Promise<SpanEntry[]> =>
    cache.get(c.n, async () => (await loadSpanChunk(loader, c, epoch)).entries);

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
      if (!shards.has(name)) shards.set(name, await index.shard(name));
      const entry = shards.get(name)?.[id];
      if (entry === undefined) continue;
      facts.set(id, {
        start: entry.start,
        end: entry.end,
        spans: entry.spans,
        errors: entry.errors,
        root: entry.root,
        complete:
          run.seenRows(id).length === entry.spans &&
          chunks.listed(entry.chunks).every((c) => scannedChunks.has(c.n)),
      });
    }
    return facts;
  };

  return {
    async querySpans(q, onProgress, signal) {
      const run = new SpanQueryRun(q, signal);
      const { targets, unfiltered } = chunks.targets(q);
      const { scanned, partial } = await scanChunks({
        targets,
        total: chunks.ordered.length,
        entries: chunkEntries,
        run,
        cap,
        // Traces mode finishes the chunk it is in, so the traces it matched are seen whole within it.
        finishChunk: q.mode === 'traces',
        onProgress,
        signal,
      });
      const facts = q.mode === 'traces' ? await traceFacts(run, scanned, signal) : undefined;
      const result = run.finish(partial, facts === undefined ? undefined : (id) => facts.get(id));
      if (!unfiltered) return result;
      // With nothing to filter on, the list is the head of the whole run; the aggregates and the size are the run's own.
      const aggregates = { facets: rollups.facets, buckets: rollups.buckets, red: rollups.red };
      return q.mode === 'traces'
        ? { ...result, ...aggregates }
        : { ...result, ...aggregates, total: manifest.totals.spans };
    },

    async hasTrace(traceId: TraceId) {
      const entry = await index.entry(traceId);
      return entry !== null && entry.spans > 0;
    },

    async getTrace(traceId: TraceId) {
      const entry = await index.entry(traceId);
      if (entry === null || entry.spans === 0) throw traceNotFound(traceId);
      const perChunk = await Promise.all(chunks.listed(entry.chunks).map((c) => chunkEntries(c)));
      return assembleTrace(
        traceId,
        perChunk.flat().filter((e) => e.row.span.traceId === traceId),
      );
    },
  };
}
