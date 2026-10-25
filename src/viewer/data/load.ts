import { decodeColumns } from '../../format/columns.js';
import { reviveDataJson } from '../../format/data-file.js';
import type { Manifest, ManifestChunk } from '../../format/manifest.js';
import {
  chunkKey,
  rollupKey,
  rollupPath,
  shardOf,
  traceShardKey,
  traceShardPath,
} from '../../format/paths.js';
import { SPAN_COLUMNS } from '../../format/specs.js';
import { type TraceEntry, TraceShardSchema } from '../../format/trace-shard.js';
import { parseWith } from '../../format/validate.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId, UnixNanos } from '../../model/ids.js';
import { SpanRollups } from '../../rollups/span-rollups.js';
import type { ScriptLoader } from './script-loader.js';
import { type LoadedChunk, QUERY_FACET_CAPS, type SpanEntry, toEntries } from './span-query.js';

export function epochOf(manifest: Manifest): UnixNanos {
  return BigInt(manifest.epochUnixNano) as UnixNanos;
}

/** Load and decode one span chunk listed in the manifest. */
export async function loadSpanChunk(
  loader: ScriptLoader,
  chunk: ManifestChunk,
  epoch: UnixNanos,
): Promise<{ chunk: LoadedChunk; entries: SpanEntry[] }> {
  const key = chunkKey('spans', chunk.n);
  const decoded = decodeColumns(SPAN_COLUMNS, reviveDataJson(await loader.load(chunk.path, key)));
  if (decoded.rows.length !== chunk.count) {
    throw new OtelHtmlError('invalid-report', {
      path: chunk.path,
      expected: `${chunk.count} spans (manifest count)`,
      actual: String(decoded.rows.length),
    });
  }
  const loaded: LoadedChunk = { n: chunk.n, resources: decoded.resources, scopes: decoded.scopes };
  return { chunk: loaded, entries: toEntries(loaded, decoded.rows, epoch, chunk.path) };
}

export async function loadSpanRollups(loader: ScriptLoader, manifest: Manifest): Promise<SpanRollups> {
  const path = rollupPath('spans');
  if (!manifest.rollups.includes(path)) {
    throw new OtelHtmlError('invalid-report', {
      path: 'manifest.rollups',
      expected: `a listing of ${path}`,
      actual: JSON.stringify(manifest.rollups),
    });
  }
  return SpanRollups.from(
    reviveDataJson(await loader.load(path, rollupKey('spans'))),
    QUERY_FACET_CAPS,
    path,
  );
}

/**
 * The trace's index entry, or null when the manifest lists no shard for it or the shard has no such trace.
 * The shard may be newer than the manifest after a crash, so its chunk refs are filtered by the caller.
 */
export async function loadTraceEntry(
  loader: ScriptLoader,
  manifest: Manifest,
  traceId: TraceId,
): Promise<TraceEntry | null> {
  const shard = shardOf(traceId);
  const path = traceShardPath(shard);
  if (!manifest.traceShards.includes(path)) return null;
  const payload = reviveDataJson(await loader.load(path, traceShardKey(shard)));
  return parseWith(TraceShardSchema, payload, path)[traceId] ?? null;
}
