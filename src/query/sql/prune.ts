import type { ManifestV4 } from '../../format/manifest.js';
import type { Table } from '../../format/parquet/columns.js';
import type { PruneHints } from './ottl.js';

/** Absolute nanoseconds (epoch added). */
export interface AbsWindow {
  start: bigint;
  end: bigint;
}

export interface Pruned {
  /** Kept files under the names `resolve` gives them (the view's `filename` values), in manifest order. */
  files: readonly string[];
  /** All files kept: no `filename` predicate is needed. Also true when the table has no file; treat `files.length === 0` as "send nothing". */
  all: boolean;
  total: number;
}

/** Report-relative window, structurally the viewer's `TimeWindow` (src/query must not import src/viewer). */
export interface RelWindow {
  start: number;
  end: number;
}

export function absWindow(w: RelWindow | null, epoch: bigint): AbsWindow | null {
  return w === null
    ? null
    : { start: BigInt(Math.floor(w.start)) + epoch, end: BigInt(Math.ceil(w.end)) + epoch };
}

const identity = (path: string): string => path;

/**
 * The files of `table` a query must read. A file is dropped when, for some hint key, the file's `values[key]` is an
 * array disjoint from the hint set (an `attr:`/`resource:` key only when `manifest.statisticsKeys[table]` lists it);
 * or when `window` is set and `timeMin > window.end`; or, for logs and points only, when `timeMax < window.start`; or, for spans and traces with a `timeEndMax`, when `timeEndMax < window.start`; under `opts.long` (selection by start time) a spans, traces or span-rollup file also goes when `timeMax` (its latest start) `< window.start`, whatever the format; a log rollup is pruned like logs.
 * `null` statistics and keys the file lacks keep the file.
 */
export function prunePartitions(
  manifest: ManifestV4,
  table: Table,
  hints: PruneHints,
  window: AbsWindow | null,
  resolve: (path: string) => string = identity,
  opts: { long?: boolean } = {},
): Pruned {
  const listed = new Set(manifest.statisticsKeys[table]);
  const usable = [...hints].filter(([key]) => !key.includes(':') || listed.has(key));
  const endBound = table === 'spans' || table === 'traces';
  // a span rollup's time is the start of the grain of a span's start: a long window (aligned) selects it as it selects spans
  const startKeyed = endBound || table === 'span_rollups';
  const lowerBound =
    table === 'logs' || table === 'points' || table === 'log_rollups' || (opts.long === true && startKeyed);
  const files: string[] = [];
  let total = 0;
  for (const partition of manifest.partitions) {
    const f = partition.files[table];
    if (f === undefined) continue;
    total++;
    const excluded = usable.some(([key, wanted]) => {
      const values = f.values[key];
      return values != null && !values.some((v) => wanted.has(v));
    });
    if (excluded) continue;
    if (window !== null) {
      if (f.timeMin !== null && BigInt(f.timeMin) > window.end) continue;
      if (endBound && f.timeEndMax != null && BigInt(f.timeEndMax) < window.start) continue;
      if (lowerBound && f.timeMax !== null && BigInt(f.timeMax) < window.start) continue;
    }
    files.push(resolve(f.path));
  }
  return { files, all: files.length === total, total };
}
