import { type ExprNode, sql, verbatim } from '@uwdata/mosaic-sql';
import { relTime } from './columns.js';
import type { RelWindow } from './prune.js';

const BASE_WIDTH_NS = 1_000_000;
const MAX_BUCKETS = 4096;

/** Buckets of `widthNs` (1 ms * 2^k) aligned to multiples of it, over `[startNs, endNs]` (both aligned; `endNs` is the start of the last bucket), relative to the epoch. */
export interface BucketSpec {
  widthNs: number;
  startNs: number;
  endNs: number;
}

/** Exact modulo with a non-negative result (the rule of `TimeBuckets`). */
const mod = (a: number, b: number): number => ((a % b) + b) % b;

/**
 * The bucketing of `TimeBuckets` (src/rollups/time-buckets.ts) for a known extent: the window, else the manifest range
 * (both relative), widths `1 ms * 2^k`, the smallest that fits `maxBuckets` (4096) buckets. No extent gives one 1 ms bucket at 0.
 */
export function bucketSpec(
  window: RelWindow | null,
  range: RelWindow | null,
  maxBuckets: number = MAX_BUCKETS,
): BucketSpec {
  const extent = window ?? range;
  if (extent === null) return { widthNs: BASE_WIDTH_NS, startNs: 0, endNs: 0 };
  let width = BASE_WIDTH_NS;
  let lo = Math.floor(extent.start);
  let hi = Math.max(lo, Math.ceil(extent.end));
  lo -= mod(lo, width);
  hi -= mod(hi, width);
  while ((hi - lo) / width + 1 > maxBuckets) {
    width *= 2;
    lo = Math.floor(extent.start);
    hi = Math.max(lo, Math.ceil(extent.end));
    lo -= mod(lo, width);
    hi -= mod(hi, width);
  }
  return { widthNs: width, startNs: lo, endNs: hi };
}

/**
 * `greatest(floorDiv(rel, w) * w, startNs)` over the relative time of `col`, with the non-negative-modulo floor
 * division of time-buckets.ts; a span starting before the first bucket counts in it.
 */
export function bucketExpr(colName: string, spec: BucketSpec, epoch: bigint): ExprNode {
  const w = `${spec.widthNs}::BIGINT`;
  return sql`greatest(${relTime(colName, epoch)} - ((${relTime(colName, epoch)} % ${verbatim(w)}) + ${verbatim(w)}) % ${verbatim(w)}, ${verbatim(`${spec.startNs}::BIGINT`)})`;
}
