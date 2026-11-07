import type { PartitionEntry } from '../format/manifest.js';
import { at } from './checkpoint.js';
import type { FileSystem } from './ports.js';

const PARTITIONS_DIR = 'data/partitions';

/** `partitionDir`'s names: six digits, or more without a leading zero for n >= 10^6. Nothing else is ours. */
const CANONICAL = /^(?:[0-9]{6}|[1-9][0-9]{6,})$/;

/**
 * Removes what an interrupted session left under `data/partitions/` that the manifest does not list, so a later cut
 * never meets a stale file and a report never carries dead data:
 *
 * - a canonical folder (`<p6>`) of no listed partition, with everything in it (a cut whose manifest write failed, a
 *   half-written compaction, the flush partitions a compaction replaced);
 * - in a listed folder, every file or folder the manifest does not list for it (a stale table file, `.merge-*`).
 *
 * Anything that is not a canonical folder name is left alone. Runs at open, under the report's lock, before the
 * session's first write. Returns how many entries it removed.
 */
export async function prunePartitions(
  fs: FileSystem,
  out: string,
  partitions: readonly PartitionEntry[],
): Promise<number> {
  if (!(await fs.exists(at(out, PARTITIONS_DIR)))) return 0;
  const keep = new Map<string, Set<string>>();
  for (const e of partitions) {
    for (const f of Object.values(e.files)) {
      const parts = f.path.split('/');
      const folder = parts.at(-2);
      const file = parts.at(-1);
      if (folder === undefined || file === undefined) continue;
      let names = keep.get(folder);
      if (names === undefined) {
        names = new Set();
        keep.set(folder, names);
      }
      names.add(file);
    }
    // A listed partition with no files still owns its (empty) folder.
    const folder = String(e.n).padStart(6, '0');
    if (!keep.has(folder)) keep.set(folder, new Set());
  }
  let removed = 0;
  for (const name of await fs.list(at(out, PARTITIONS_DIR))) {
    if (!CANONICAL.test(name)) continue;
    const dir = at(out, `${PARTITIONS_DIR}/${name}`);
    const wanted = keep.get(name);
    if (wanted === undefined) {
      await fs.removeDir(dir);
      removed++;
      continue;
    }
    for (const inner of await fs.list(dir)) {
      if (wanted.has(inner)) continue;
      await fs.removeDir(at(dir, inner));
      removed++;
    }
  }
  return removed;
}
