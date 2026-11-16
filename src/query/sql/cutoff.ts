import { column, Query, sql } from '@uwdata/mosaic-sql';
import type { ManifestV4, PartitionFile } from '../../format/manifest.js';
import { type SqlFilter, whereOf } from './filter.js';
import type { Pruned } from './prune.js';
import { splitFiles, windowProblem } from './rollup.js';

type ListTable = 'spans' | 'logs' | 'traces';

export interface Cutoff {
  /** The kept files (manifest order), as a `Pruned` over the same `total`; `all` only when nothing was left out. */
  files: Pruned;
  /** Every file of `pruned` that may hold a matching row is in (a file `counts` gives 0 never is). */
  complete: boolean;
}

interface Entry {
  path: string;
  rows: number;
  min: bigint | null;
  max: bigint | null;
  end: bigint | null;
}

const big = (v: string | null | undefined): bigint | null => (v == null ? null : BigInt(v));

/**
 * The fewest files of `pruned` (names as manifest paths) that can hold the first `need` rows of a list ordered by time,
 * newest first (`dir: 'desc'`, the default) or oldest first. Files are taken newest by `timeMax` (oldest by `timeMin`)
 * until their rows, `counts` (base file path to matching rows) where given, else the file's `rows`, reach `need`; a file
 * with no entry in `counts` is unknown and counts at its `rows`, never zero. `after` is what an earlier page used: it is
 * kept, counts toward `need`, and at least one further file is added.
 *
 * Then every other file overlapping the core in time is added (desc: `timeMax` at or above the core's smallest
 * `timeMin`; asc: `timeMin` at or below its largest `timeMax`; traces, desc: also `timeEndMax` at or above it), so every
 * file left out lies wholly beyond the core, and the first `need` rows of the core are the first `need` rows overall
 * (given the core holds `need` rows). A file without time statistics is always kept and counts for nothing; a
 * file the manifest does not list is kept too.
 */
export function newestFiles(
  manifest: ManifestV4,
  table: ListTable,
  pruned: Pruned,
  need: number,
  opts: { dir?: 'asc' | 'desc'; counts?: ReadonlyMap<string, number>; after?: Pruned } = {},
): Cutoff {
  const after = new Set(opts.after?.files ?? []);
  const desc = (opts.dir ?? 'desc') === 'desc';
  const byPath = new Map<string, PartitionFile>();
  for (const p of manifest.partitions) {
    const f = p.files[table];
    if (f !== undefined) byPath.set(f.path, f);
  }
  // a file `counts` says holds no matching row is never read
  const empty = (path: string): boolean => opts.counts?.get(path) === 0;
  const entries: Entry[] = pruned.files
    .filter((p) => !empty(p) || after.has(p))
    .map((path) => {
      const f = byPath.get(path);
      const rows = f === undefined ? 0 : (opts.counts?.get(path) ?? f.rows);
      return { path, rows, min: big(f?.timeMin), max: big(f?.timeMax), end: big(f?.timeEndMax) };
    });
  const kept = new Set<string>();
  const dated: Entry[] = [];
  for (const e of entries) {
    if (e.min === null || e.max === null) kept.add(e.path);
    else dated.push(e);
  }
  const key = (e: Entry): bigint => (desc ? (e.max as bigint) : -(e.min as bigint));
  dated.sort((a, b) => (key(a) === key(b) ? 0 : key(a) > key(b) ? -1 : 1));
  const core: Entry[] = dated.filter((e) => after.has(e.path));
  let rows = core.reduce((n, e) => n + e.rows, 0);
  for (const e of core) kept.add(e.path);
  let added = after.size === 0;
  for (const e of dated) {
    if (after.has(e.path)) continue;
    if (added && rows >= need) break;
    core.push(e);
    kept.add(e.path);
    rows += e.rows;
    added = true;
  }
  if (core.length > 0) {
    const bound = desc
      ? core.reduce((m, e) => ((e.min as bigint) < m ? (e.min as bigint) : m), core[0]?.min as bigint)
      : core.reduce((m, e) => ((e.max as bigint) > m ? (e.max as bigint) : m), core[0]?.max as bigint);
    for (const e of dated) {
      if (kept.has(e.path)) continue;
      const overlaps = desc
        ? (e.max as bigint) >= bound || (table === 'traces' && (e.end === null || e.end >= bound))
        : (e.min as bigint) <= bound;
      if (overlaps) kept.add(e.path);
    }
  }
  const files = entries.map((e) => e.path).filter((p) => kept.has(p));
  const complete = files.length === entries.length;
  return {
    files: { files, all: pruned.all && files.length === pruned.files.length, total: pruned.total },
    complete,
  };
}

/** What `rollupCounts` builds: the statement (null when no file has a usable rollup) and how its rows map back. */
export interface RollupCounts {
  /** Rows (`filename`, `n`): matching rows per rollup file, `GROUP BY filename`. */
  query: Query | null;
  /** Rollup file name to the base file of its partition. */
  baseOf: ReadonlyMap<string, string>;
}

/**
 * One statement counting, per rollup file, the rows `f` matches, for the base files of `pruned` whose partition has a
 * rollup that holds everything `reads` names (the routing of `splitFiles`, durations not needed). A partition
 * whose rollup lacks a dimension, or has none, is absent from `baseOf`: its count is unknown. `f` is applied as the
 * rollup branch of `measuresRelation` applies it (a text search, or a window that is not long and grain-aligned, gives no query: every count is unknown).
 * Names are manifest paths, as `prunePartitions` gives them without a `resolve`.
 */
export function rollupCounts(
  manifest: ManifestV4,
  table: 'spans' | 'logs',
  pruned: Pruned,
  f: SqlFilter,
  reads: ReadonlySet<string>,
): RollupCounts {
  // what a rollup cannot answer exactly gives no counts (every count unknown), never a wrong one
  if (f.text !== null || windowProblem(f) !== null) return { query: null, baseOf: new Map() };
  const split = splitFiles(manifest, table, pruned, reads, { durations: false, rawOnly: false });
  if (split.rollup.length === 0) return { query: null, baseOf: new Map() };
  const rollupTable = table === 'spans' ? 'span_rollups' : 'log_rollups';
  const used = new Set(split.rollup);
  const baseOf = new Map<string, string>();
  for (const p of manifest.partitions) {
    const r = p.files[rollupTable];
    const b = p.files[table];
    if (r !== undefined && b !== undefined && used.has(r.path)) baseOf.set(r.path, b.path);
  }
  const own: SqlFilter = {
    ...f,
    files: { files: split.rollup, all: false, total: split.rollup.length },
  };
  const query = Query.from(rollupTable)
    .select({ filename: column('filename'), n: sql`CAST(coalesce(sum(n), 0) AS BIGINT)` })
    .where(...whereOf(own, table))
    .groupby(column('filename'));
  return { query, baseOf };
}

/** `rollupCounts`' result rows as counts per base file: a rollup file that returned no row matched nothing (0). */
export function countsFromRows(
  c: RollupCounts,
  rows: readonly { filename: string; n: number | bigint }[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const base of c.baseOf.values()) out.set(base, 0);
  for (const r of rows) {
    const base = c.baseOf.get(r.filename);
    if (base !== undefined) out.set(base, Number(r.n));
  }
  return out;
}
