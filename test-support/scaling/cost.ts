import type { ReadEvent } from './counting-engine.js';

/** What a statement costs in file reads: serial requests, parallel requests (the `prepared` files) and bytes. */
export interface Cost {
  serial: number;
  parallel: number;
  bytes: number;
}

/** Chromium requests one open of a Parquet file costs (calibration, Task 1: the HEAD plus the footer range reads). */
export const REQUESTS_PER_OPEN = 1;

/**
 * Reads of a path in `prepared` cost one parallel request of the file's size; all other events are serial: an open is
 * `REQUESTS_PER_OPEN` requests, a read is one, and `bytes` sums what the reads returned.
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
      cost.serial += 1;
      cost.bytes += e.bytes;
    }
  }
  return cost;
}
