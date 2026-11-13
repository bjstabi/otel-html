import { type ExprNode, sql, verbatim } from '@uwdata/mosaic-sql';
import { ROLLUP_GRAIN_NS } from '../../format/manifest.js';
import { relTime } from './columns.js';
import type { RelWindow } from './prune.js';

const BASE_WIDTH_NS = 1_000_000;
const MAX_BUCKETS = 4096;

/** Buckets of `widthNs` (1 ms * 2^k) aligned to multiples of it, over `[startNs, endNs]` (both aligned; `endNs` is the start of the last bucket), relative to the epoch. */
export interface BucketSpec {
  widthNs: number;
  startNs: number;
  endNs: number;
  /** The relative time of one absolute multiple of `widthNs`, in `[0, widthNs)`. 0 outside `long`; under it `mod(-epoch, widthNs)`. */
  originNs: number;
}

/** Exact modulo with a non-negative result (the rule of `TimeBuckets`). */
const mod = (a: number, b: number): number => ((a % b) + b) % b;

/** `mod(-epoch, width)` in bigint: epochs exceed 2^53. */
function originOf(epoch: bigint, width: number): number {
  const w = BigInt(width);
  return Number((w - (epoch % w)) % w);
}

/**
 * The bucketing of `TimeBuckets` (src/rollups/time-buckets.ts) for a known extent: the window, else the manifest range
 * (both relative), widths `1 ms * 2^k`, the smallest that fits `maxBuckets` (4096) buckets. No extent gives one 1 ms bucket at 0.
 */
export function bucketSpec(
  window: RelWindow | null,
  range: RelWindow | null,
  maxBuckets: number = MAX_BUCKETS,
  long?: { epoch: bigint },
): BucketSpec {
  const extent = window ?? range;
  if (extent === null) return { widthNs: BASE_WIDTH_NS, startNs: 0, endNs: 0, originNs: 0 };
  // Under `long` the width is at least one rollup grain and buckets sit on multiples of it in absolute time.
  let width = long === undefined ? BASE_WIDTH_NS : ROLLUP_GRAIN_NS;
  const place = (): { lo: number; hi: number; origin: number } => {
    const origin = long === undefined ? 0 : originOf(long.epoch, width);
    let lo = Math.floor(extent.start);
    let hi = Math.max(lo, Math.ceil(extent.end));
    lo -= mod(lo - origin, width);
    hi -= mod(hi - origin, width);
    return { lo, hi, origin };
  };
  let f = place();
  while ((f.hi - f.lo) / width + 1 > maxBuckets) {
    width *= 2;
    f = place();
  }
  return { widthNs: width, startNs: f.lo, endNs: f.hi, originNs: f.origin };
}

/**
 * `greatest(floorDiv(rel, w) * w, startNs)` over the relative time of `col`, with the non-negative-modulo floor
 * division of time-buckets.ts; a span starting before the first bucket counts in it.
 */
export function bucketExpr(colName: string, spec: BucketSpec, epoch: bigint): ExprNode {
  const w = `${spec.widthNs}::BIGINT`;
  const rel = relTime(colName, epoch);
  const shifted = spec.originNs === 0 ? rel : sql`(${rel} - ${verbatim(`${spec.originNs}::BIGINT`)})`;
  return sql`greatest(${rel} - ((${shifted} % ${verbatim(w)}) + ${verbatim(w)}) % ${verbatim(w)}, ${verbatim(`${spec.startNs}::BIGINT`)})`;
}
