import { OtelHtmlError } from '../../model/errors.js';

/** The bucket cap of every time series a query returns. */
export const MAX_BUCKETS = 4096;

export interface Grid {
  start: number;
  length: number;
}

/** The dense grid from the first to the last occupied bucket of `buckets` (relative ns, aligned to `width`; far from the anchor the doubles are rounded, so the length is rounded too). */
export function gridOf(buckets: readonly number[], width: number): Grid | null {
  if (buckets.length === 0) return null;
  const lo = Math.min(...buckets);
  const hi = Math.max(...buckets);
  return { start: lo, length: Math.round((hi - lo) / width) + 1 };
}

export function slot(bucket: number, grid: Grid, width: number): number {
  const raw = (bucket - grid.start) / width;
  const i = Math.round(raw);
  // Times past 2^53 ns were rounded to the nearest double, so a bucket may sit a few ulps off its slot.
  const magnitude = Math.max(Math.abs(bucket), Math.abs(grid.start));
  const slack = magnitude > Number.MAX_SAFE_INTEGER ? (2 * magnitude * Number.EPSILON) / width : 0;
  if (!Number.isFinite(raw) || Math.abs(raw - i) > slack || i < 0 || i >= grid.length)
    throw new OtelHtmlError('invalid-report', {
      path: 'bucket',
      expected: 'a bucket on the grid',
      actual: JSON.stringify(bucket) ?? String(bucket),
    });
  return i;
}

export const zeros = (n: number): number[] => new Array<number>(n).fill(0);
