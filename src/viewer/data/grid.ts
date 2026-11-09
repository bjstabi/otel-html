import { OtelHtmlError } from '../../model/errors.js';

/** The bucket cap of every time series a query returns. */
export const MAX_BUCKETS = 4096;

export interface Grid {
  start: number;
  length: number;
}

/** The dense grid from the first to the last occupied bucket of `buckets` (relative ns, aligned to `width`). */
export function gridOf(buckets: readonly number[], width: number): Grid | null {
  if (buckets.length === 0) return null;
  const lo = Math.min(...buckets);
  const hi = Math.max(...buckets);
  return { start: lo, length: (hi - lo) / width + 1 };
}

export function slot(bucket: number, grid: Grid, width: number): number {
  const i = (bucket - grid.start) / width;
  if (!Number.isInteger(i) || i < 0 || i >= grid.length)
    throw new OtelHtmlError('invalid-report', {
      path: 'bucket',
      expected: 'a bucket on the grid',
      actual: JSON.stringify(bucket) ?? String(bucket),
    });
  return i;
}

export const zeros = (n: number): number[] => new Array<number>(n).fill(0);
