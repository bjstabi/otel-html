import type { Manifest } from '../../format/manifest.js';
import type { TraceId } from '../../model/ids.js';
import type { StrategySource } from './data-source.js';
import { epochOf, loadSpanChunk } from './load.js';
import type { ScriptLoader } from './script-loader.js';
import { querySpanEntries, type SpanEntry } from './span-query.js';
import { assembleTrace } from './trace-detail.js';

/** Load every span chunk listed in the manifest once; queries then filter in memory and are exact. */
export async function createEagerSource(loader: ScriptLoader, manifest: Manifest): Promise<StrategySource> {
  const epoch = epochOf(manifest);
  const loaded = await Promise.all(
    manifest.chunks.filter((c) => c.signal === 'spans').map((c) => loadSpanChunk(loader, c, epoch)),
  );
  const entries = loaded.flatMap((l) => l.entries);
  const byTrace = new Map<TraceId, SpanEntry[]>();
  for (const e of entries) {
    const list = byTrace.get(e.row.span.traceId);
    if (list === undefined) byTrace.set(e.row.span.traceId, [e]);
    else list.push(e);
  }
  return {
    querySpans(q, _onProgress, signal) {
      try {
        return Promise.resolve(querySpanEntries(entries, q, signal));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    getTrace(traceId) {
      try {
        return Promise.resolve(assembleTrace(traceId, byTrace.get(traceId) ?? []));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
}
