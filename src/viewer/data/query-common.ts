import type { Query } from '@uwdata/mosaic-sql';
import type { ManifestV4 } from '../../format/manifest.js';
import type { Table } from '../../format/parquet/columns.js';
import type { Pruned } from '../../query/sql/prune.js';
import { tableFiles } from '../../query/sql/views.js';

/** The caps a filtered set's facets are built with: format 4 uses `DEFAULT_FACET_CAPS` (the manifest records no writer caps and facets are computed at view time). */
export interface FacetCaps {
  readonly facetValueCap: number;
  readonly facetKeyCap: number;
}

/** Fallback for callers without a report (the writer's defaults). */
export const DEFAULT_FACET_CAPS: FacetCaps = { facetValueCap: 1_000, facetKeyCap: 500 };

/** Queries reject with a `DOMException` named `AbortError` (the platform's own abort convention). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('The query was aborted', 'AbortError');
}

export const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The files a statement over `tables` reads: every file of each table, except that `pruned` (the filter's kept files)
 * stands for the first table's. The views read all files of a table, so what `pruned` leaves out is not read.
 */
export function filesFor(manifest: ManifestV4, tables: readonly Table[], pruned?: Pruned): readonly string[] {
  const keep = (path: string): string => path;
  return tables.flatMap((table, i) =>
    i === 0 && pruned !== undefined ? pruned.files : tableFiles(manifest, table, keep),
  );
}

/** The one way the data layer runs a statement: the engine prepares `files` first, then runs `q`. */
export async function runPrepared<T>(
  engine: {
    prepare(paths: readonly string[], signal?: AbortSignal): Promise<void>;
    query(q: Query, signal?: AbortSignal): Promise<T>;
  },
  q: Query,
  files: readonly string[],
  signal?: AbortSignal,
): Promise<T> {
  await engine.prepare(files, signal);
  return engine.query(q, signal);
}
