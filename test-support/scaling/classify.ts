import type { CostClass } from '../../src/viewer/data/catalogue.js';
import type { Cost } from './cost.js';

/** One step of an axis: the shape's size, what the request needs of it, and what it cost cold. */
export interface Step {
  partitions: number;
  /** Row groups of the partitions the request selects (its window, or all). */
  selectedGroups: number;
  /** Row groups that hold rows the request must read. */
  neededGroups: number;
  /** The serial count of the entry's unconditioned sibling (`Declared.scanOf`) at this step; its own when it has none. */
  reference: number;
  cost: Cost;
}

/** Whole-file fetches of small files a partition may add (a spans, logs and traces file, and so on, in parallel). */
export const FILES_PER_PARTITION = 3;

/** The tolerance of `fixed` on bytes (the last step against the first). */
const BYTES_TOLERANCE = 0.1;
/** The factor `matched` allows over the share of the reference a pruned request is entitled to. */
const MATCHED_FACTOR = 1.25;
/** The serial requests `matched` allows whatever the share (a footer, a probe). */
const MATCHED_SLACK = 2;

/**
 * The best class a series of steps (an axis, three values) satisfies, §3.2:
 *
 * - `fixed`: serial and parallel equal at every step, bytes of the last step within 10 % of the first;
 * - `files`: serial equal, parallel growing by at most `FILES_PER_PARTITION` per added partition, bytes free;
 * - `matched`: the needed groups grow less than the selected ones and the serial growth stays within 1.25 times that
 *   share of the reference's growth (and never under `MATCHED_SLACK`);
 * - `scan` otherwise.
 */
export function classify(steps: readonly Step[]): CostClass {
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (first === undefined || last === undefined || steps.length < 2) return 'scan';
  const serialEqual = steps.every((s) => s.cost.serial === first.cost.serial);
  const parallelEqual = steps.every((s) => s.cost.parallel === first.cost.parallel);
  if (
    serialEqual &&
    parallelEqual &&
    Math.abs(last.cost.bytes - first.cost.bytes) <= BYTES_TOLERANCE * first.cost.bytes
  )
    return 'fixed';
  if (
    serialEqual &&
    steps.every((s, i) => {
      const prev = steps[i - 1];
      return (
        prev === undefined ||
        s.cost.parallel - prev.cost.parallel <= FILES_PER_PARTITION * (s.partitions - prev.partitions)
      );
    })
  )
    return 'files';
  const neededGrowth = last.neededGroups - first.neededGroups;
  const selectedGrowth = last.selectedGroups - first.selectedGroups;
  if (neededGrowth < selectedGrowth) {
    const share = neededGrowth / selectedGrowth;
    if (
      last.cost.serial - first.cost.serial <=
      Math.max(MATCHED_SLACK, MATCHED_FACTOR * share * (last.reference - first.reference))
    )
      return 'matched';
  }
  return 'scan';
}
