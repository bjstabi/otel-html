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
import { type TraceEntry, type TraceShard, TraceShardSchema } from '../../format/trace-shard.js';
import { parseWith } from '../../format/validate.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId, UnixNanos } from '../../model/ids.js';
import { SpanRollups } from '../../rollups/span-rollups.js';
import { QUERY_FACET_CAPS } from './query-common.js';
import type { ScriptLoader } from './script-loader.js';
import { type LoadedChunk, type SpanEntry, toEntries } from './span-query.js';

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
 * One trace-index shard, or null when the manifest lists none for it. The shard may be newer than the
 * manifest after a crash, so callers filter its chunk refs against the manifest.
 */
export async function loadTraceShard(
  loader: ScriptLoader,
  manifest: Manifest,
  shard: string,
): Promise<TraceShard | null> {
  const path = traceShardPath(shard);
  if (!manifest.traceShards.includes(path)) return null;
  return parseWith(TraceShardSchema, reviveDataJson(await loader.load(path, traceShardKey(shard))), path);
}

export async function loadTraceEntry(
  loader: ScriptLoader,
  manifest: Manifest,
  traceId: TraceId,
): Promise<TraceEntry | null> {
  return (await loadTraceShard(loader, manifest, shardOf(traceId)))?.[traceId] ?? null;
}
