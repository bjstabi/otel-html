import type { ManifestV4 } from '../../format/manifest.js';
import { newestFiles } from '../../query/sql/cutoff.js';
import type { Pruned } from '../../query/sql/prune.js';

type ListTable = 'spans' | 'logs' | 'traces';

/**
 * The first rows of a list ordered by time, read from the fewest files that can fill them. The files are the cutoff
 * of `newestFiles` (the newest for `dir: 'desc'`, the oldest for `asc`); when `counts` can say how many rows of each
 * match they come first, and a page the files cannot fill (a filter matched too little there) reads the next group
 * until it fills or every file is in. `read(files, complete)` runs the rows statement (`complete`: every file is in) and returns its row count with its result.
 * `counts` is asked at most once, and only when the files by `rows` alone would not be every file.
 */
export async function readPage<T>(opts: {
  manifest: ManifestV4;
  table: ListTable;
  pruned: Pruned;
  /** Rows wanted. */
  need: number;
  dir: 'asc' | 'desc';
  counts?: () => Promise<ReadonlyMap<string, number> | undefined>;
  read: (files: Pruned, complete: boolean) => Promise<{ rows: number; value: T }>;
}): Promise<{ value: T; files: Pruned; rows: number; complete: boolean }> {
  const { manifest, table, pruned, need, dir } = opts;
  let counts: ReadonlyMap<string, number> | undefined;
  let cut = newestFiles(manifest, table, pruned, need, { dir });
  if (!cut.complete && opts.counts !== undefined) {
    counts = await opts.counts();
    if (counts !== undefined) cut = newestFiles(manifest, table, pruned, need, { dir, counts });
  }
  for (;;) {
    const page = await opts.read(cut.files, cut.complete);
    if (page.rows >= need || cut.complete) return { ...page, files: cut.files, complete: cut.complete };
    const more = newestFiles(manifest, table, pruned, need, {
      dir,
      after: cut.files,
      ...(counts === undefined ? {} : { counts }),
    });
    if (more.files.files.length <= cut.files.files.length) {
      return { ...page, files: cut.files, complete: cut.complete };
    }
    cut = more;
  }
}

/** The files in the order a rows statement of sort direction `dir` reads them: manifest order (oldest first) reversed for `desc`. */
export const inReadOrder = (files: Pruned, dir: 'asc' | 'desc'): readonly string[] =>
  dir === 'desc' ? [...files.files].reverse() : files.files;

/**
 * The files of `pruned` that can hold a row after a cursor at the absolute time `at`: `desc` lists want rows at or before
 * it (`timeMin <= at`), `asc` lists at or after it (`timeMax >= at`). A file without time statistics, or one the manifest
 * does not list, stays (the cursor's predicate decides there).
 */
export function afterCursor(
  manifest: ManifestV4,
  table: ListTable,
  pruned: Pruned,
  at: bigint,
  dir: 'asc' | 'desc',
): Pruned {
  const byPath = new Map<string, { min: bigint | null; max: bigint | null }>();
  for (const p of manifest.partitions) {
    const f = p.files[table];
    if (f !== undefined) {
      byPath.set(f.path, {
        min: f.timeMin == null ? null : BigInt(f.timeMin),
        max: f.timeMax == null ? null : BigInt(f.timeMax),
      });
    }
  }
  const files = pruned.files.filter((path) => {
    const t = byPath.get(path);
    if (t === undefined) return true;
    const bound = dir === 'desc' ? t.min : t.max;
    if (bound === null) return true;
    return dir === 'desc' ? bound <= at : bound >= at;
  });
  return { files, all: pruned.all && files.length === pruned.files.length, total: pruned.total };
}
