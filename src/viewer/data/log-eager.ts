import type { Manifest } from '../../format/manifest.js';
import type { TraceId } from '../../model/ids.js';
import type { LogStrategy } from './data-source.js';
import { epochOf } from './load.js';
import { loadLogChunk, logNotFound } from './log-load.js';
import {
  byTimeThenRef,
  checkSurroundingCount,
  type LogEntry,
  type LogRow,
  queryLogEntries,
  refParts,
  surroundingIn,
} from './log-query.js';
import type { ScriptLoader } from './script-loader.js';

/** Load every log chunk listed in the manifest once; queries then filter in memory and are exact. */
export async function createEagerLogSource(loader: ScriptLoader, manifest: Manifest): Promise<LogStrategy> {
  const epoch = epochOf(manifest);
  const loaded = await Promise.all(
    manifest.chunks.filter((c) => c.signal === 'logs').map((c) => loadLogChunk(loader, c, epoch)),
  );
  const byChunk = new Map<number, readonly LogEntry[]>(loaded.map((l) => [l.chunk.n, l.entries]));
  const entries = loaded.flatMap((l) => l.entries);
  const rows = entries.map((e) => e.row);
  const byTrace = new Map<TraceId, LogRow[]>();
  for (const r of rows) {
    const id = r.log.traceId;
    if (id === null) continue;
    const list = byTrace.get(id);
    if (list === undefined) byTrace.set(id, [r]);
    else list.push(r);
  }
  for (const list of byTrace.values()) list.sort(byTimeThenRef);

  const find = (ref: Parameters<LogStrategy['getLog']>[0]): LogRow => {
    const { n, i } = refParts(ref);
    const row = byChunk.get(n)?.[i]?.row;
    if (row === undefined) throw logNotFound(ref);
    return row;
  };

  return {
    queryLogs(q, _onProgress, signal) {
      try {
        return Promise.resolve(queryLogEntries(entries, q, signal));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    getLog(ref) {
      try {
        return Promise.resolve(find(ref));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    traceLogs(traceId) {
      return Promise.resolve(byTrace.get(traceId) ?? []);
    },
    logCount(traceId) {
      return Promise.resolve(byTrace.get(traceId)?.length ?? 0);
    },
    surroundingLogs(ref, n) {
      try {
        checkSurroundingCount(n);
        const log = find(ref);
        return Promise.resolve({ ...surroundingIn(log, rows, n), log, partial: false });
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
}
