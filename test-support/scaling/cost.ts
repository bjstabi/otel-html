import type { ReadEvent } from './counting-engine.js';

/** What a statement costs in file reads: serial requests, parallel requests (the `prepared` files) and bytes. */
export interface Cost {
  serial: number;
  parallel: number;
  bytes: number;
}

/**
 * Chromium requests one open of a Parquet file costs, apart from the reads Node counts for it (calibration, Task 1: a
 * HEAD and DuckDB's `bytes=0-0` probe GET; the footer read is one of the Node reads).
 */
export const REQUESTS_PER_OPEN = 2;

/** Chromium range GETs one Node read call costs (calibration, Task 1: the `k` of decision 3). */
export const REQUESTS_PER_READ = 1;

/**
 * Rows of the row groups a scaling report is written with in place of the writer's 50,000. PROVISIONAL: no size passed
 * the calibration of Task 1 step 5 (see the Calibration section of the plan); 8,192 is the closest.
 */
export const ROW_GROUP_ROWS = 8192;

/**
 * Reads of a path in `prepared` cost one parallel request of the file's size; all other events are serial: an open is
 * `REQUESTS_PER_OPEN` requests, a read is `REQUESTS_PER_READ`, and `bytes` sums what the reads returned.
 */
export function costOf(events: readonly ReadEvent[], prepared: ReadonlyMap<string, number>): Cost {
  const cost: Cost = { serial: 0, parallel: 0, bytes: 0 };
  const counted = new Set<string>();
  for (const e of events) {
    const size = prepared.get(e.path);
    if (size !== undefined) {
      if (!counted.has(e.path)) {
        counted.add(e.path);
        cost.parallel += 1;
        cost.bytes += size;
      }
      continue;
    }
    if (e.kind === 'open') {
      cost.serial += REQUESTS_PER_OPEN;
    } else {
      cost.serial += REQUESTS_PER_READ;
      cost.bytes += e.bytes;
    }
  }
  return cost;
}
