import { decodeColumns } from '../../format/columns.js';
import { reviveDataJson } from '../../format/data-file.js';
import type { Manifest, ManifestChunk } from '../../format/manifest.js';
import { chunkKey, rollupKey, rollupPath } from '../../format/paths.js';
import { LOG_COLUMNS } from '../../format/specs.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { UnixNanos } from '../../model/ids.js';
import { LogRollups } from '../../rollups/log-rollups.js';
import { type LoadedLogChunk, type LogEntry, type LogRef, toLogEntries } from './log-query.js';
import { QUERY_FACET_CAPS } from './query-common.js';
import type { ScriptLoader } from './script-loader.js';

export function logNotFound(ref: LogRef): OtelHtmlError {
  return new OtelHtmlError('usage', {
    path: `log ${ref}`,
    expected: 'a log listed in the report',
    actual: 'not found',
  });
}

/** Load and decode one log chunk listed in the manifest. */
export async function loadLogChunk(
  loader: ScriptLoader,
  chunk: ManifestChunk,
  epoch: UnixNanos,
): Promise<{ chunk: LoadedLogChunk; entries: LogEntry[] }> {
  const key = chunkKey('logs', chunk.n);
  const decoded = decodeColumns(LOG_COLUMNS, reviveDataJson(await loader.load(chunk.path, key)));
  if (decoded.rows.length !== chunk.count) {
    throw new OtelHtmlError('invalid-report', {
      path: chunk.path,
      expected: `${chunk.count} logs (manifest count)`,
      actual: String(decoded.rows.length),
    });
  }
  const loaded: LoadedLogChunk = { n: chunk.n, resources: decoded.resources, scopes: decoded.scopes };
  return { chunk: loaded, entries: toLogEntries(loaded, decoded.rows, epoch, chunk.path) };
}

export async function loadLogRollups(loader: ScriptLoader, manifest: Manifest): Promise<LogRollups> {
  const path = rollupPath('logs');
  if (!manifest.rollups.includes(path)) {
    throw new OtelHtmlError('invalid-report', {
      path: 'manifest.rollups',
      expected: `a listing of ${path}`,
      actual: JSON.stringify(manifest.rollups),
    });
  }
  return LogRollups.from(reviveDataJson(await loader.load(path, rollupKey('logs'))), QUERY_FACET_CAPS, path);
}
