import { z } from 'zod';
import { OtelHtmlError } from '../model/errors.js';

/** Most buckets one side (positive or negative) of an `ExpAgg` keeps after a merge. */
const MAX_EXP_BUCKETS = 160;

export interface NumberAgg {
  k: 'number';
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
  lastTime: number;
}
export interface CounterAgg {
  k: 'counter';
  delta: number;
  resets: number;
}
export interface HistAgg {
  k: 'hist';
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  bounds: number[];
  counts: number[];
}
export interface ExpSide {
  /** Bucket index of `counts[0]`. */
  offset: number;
  counts: number[];
}
export interface ExpAgg {
  k: 'exp';
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  scale: number;
  zeroCount: number;
  zeroThreshold: number;
  positive: ExpSide;
  negative: ExpSide;
}
export interface SummaryAgg {
  k: 'summary';
  count: number;
  sum: number;
  quantiles: { q: number; v: number }[];
  lastTime: number;
}
export type BucketAgg = NumberAgg | CounterAgg | HistAgg | ExpAgg | SummaryAgg;

function invariantError(path: string, expected: string, actual: string): OtelHtmlError {
  return new OtelHtmlError('invalid-report', { path, expected: `invariant: ${expected}`, actual });
}

function minOrNull(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}
function maxOrNull(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.max(a, b);
}

function downscaleSide(side: ExpSide, d: number): ExpSide {
  if (d === 0 || side.counts.length === 0) return { offset: side.offset >> d, counts: [...side.counts] };
  const offset = side.offset >> d;
  const end = (side.offset + side.counts.length - 1) >> d;
  const counts = new Array<number>(end - offset + 1).fill(0);
  side.counts.forEach((c, j) => {
    const i = ((side.offset + j) >> d) - offset;
    counts[i] = (counts[i] ?? 0) + c;
  });
  return { offset, counts };
}

/** Merges neighbouring buckets so the aggregate sits at `scale` (which must not exceed its current scale). */
export function downscaleExp(e: ExpAgg, scale: number): ExpAgg {
  const d = e.scale - scale;
  if (!Number.isInteger(d) || d < 0) {
    throw invariantError('downscaleExp', `integer scale <= ${e.scale}`, String(scale));
  }
  return {
    ...e,
    scale,
    positive: downscaleSide(e.positive, d),
    negative: downscaleSide(e.negative, d),
  };
}

function addSides(a: ExpSide, b: ExpSide): ExpSide {
  if (a.counts.length === 0) return { offset: b.offset, counts: [...b.counts] };
  if (b.counts.length === 0) return { offset: a.offset, counts: [...a.counts] };
  const lo = Math.min(a.offset, b.offset);
  const hi = Math.max(a.offset + a.counts.length, b.offset + b.counts.length);
  const counts = new Array<number>(hi - lo).fill(0);
  for (const s of [a, b]) {
    s.counts.forEach((c, j) => {
      counts[s.offset - lo + j] = (counts[s.offset - lo + j] ?? 0) + c;
    });
  }
  return { offset: lo, counts };
}

function mergedSpan(a: ExpSide, b: ExpSide): number {
  if (a.counts.length === 0) return b.counts.length;
  if (b.counts.length === 0) return a.counts.length;
  return Math.max(a.offset + a.counts.length, b.offset + b.counts.length) - Math.min(a.offset, b.offset);
}

/** Drops empty edge buckets and moves buckets entirely at or below `threshold` into the returned zero count. */
function foldSide(side: ExpSide, scale: number, threshold: number): { side: ExpSide; folded: number } {
  let folded = 0;
  const counts = [...side.counts];
  let offset = side.offset;
  // Bucket `i` covers (2^(i/2^s), 2^((i+1)/2^s)]; it is below the threshold when its upper bound is.
  while (counts.length > 0 && (counts[0] === 0 || 2 ** ((offset + 1) / 2 ** scale) <= threshold)) {
    folded += counts.shift() ?? 0;
    offset += 1;
  }
  while (counts.length > 0 && counts[counts.length - 1] === 0) counts.pop();
  return { side: counts.length === 0 ? { offset: 0, counts } : { offset, counts }, folded };
}

function mergeExp(a: ExpAgg, b: ExpAgg): ExpAgg {
  let scale = Math.min(a.scale, b.scale);
  let x = downscaleExp(a, scale);
  let y = downscaleExp(b, scale);
  while (
    mergedSpan(x.positive, y.positive) > MAX_EXP_BUCKETS ||
    mergedSpan(x.negative, y.negative) > MAX_EXP_BUCKETS
  ) {
    scale -= 1;
    x = downscaleExp(x, scale);
    y = downscaleExp(y, scale);
  }
  const zeroThreshold = Math.max(a.zeroThreshold, b.zeroThreshold);
  const pos = foldSide(addSides(x.positive, y.positive), scale, zeroThreshold);
  const neg = foldSide(addSides(x.negative, y.negative), scale, zeroThreshold);
  return {
    k: 'exp',
    count: a.count + b.count,
    sum: a.sum + b.sum,
    min: minOrNull(a.min, b.min),
    max: maxOrNull(a.max, b.max),
    scale,
    zeroCount: a.zeroCount + b.zeroCount + pos.folded + neg.folded,
    zeroThreshold,
    positive: pos.side,
    negative: neg.side,
  };
}

function sameBounds(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Merges two aggregates of the same kind; the result is a fresh value, inputs are untouched. */
export function mergeAgg(a: BucketAgg, b: BucketAgg, path: string): BucketAgg {
  switch (a.k) {
    case 'number': {
      if (b.k !== 'number') break;
      const later = b.lastTime >= a.lastTime ? b : a;
      return {
        k: 'number',
        count: a.count + b.count,
        sum: a.sum + b.sum,
        min: Math.min(a.min, b.min),
        max: Math.max(a.max, b.max),
        last: later.last,
        lastTime: later.lastTime,
      };
    }
    case 'counter': {
      if (b.k !== 'counter') break;
      return { k: 'counter', delta: a.delta + b.delta, resets: a.resets + b.resets };
    }
    case 'hist': {
      if (b.k !== 'hist') break;
      if (!sameBounds(a.bounds, b.bounds)) {
        throw invariantError(path, `histograms with identical bounds [${a.bounds}]`, `bounds [${b.bounds}]`);
      }
      return {
        k: 'hist',
        count: a.count + b.count,
        sum: a.sum + b.sum,
        min: minOrNull(a.min, b.min),
        max: maxOrNull(a.max, b.max),
        bounds: [...a.bounds],
        counts: a.counts.map((c, i) => c + (b.counts[i] ?? 0)),
      };
    }
    case 'exp': {
      if (b.k !== 'exp') break;
      return mergeExp(a, b);
    }
    case 'summary': {
      if (b.k !== 'summary') break;
      const later = b.lastTime >= a.lastTime ? b : a;
      return {
        k: 'summary',
        count: a.count + b.count,
        sum: a.sum + b.sum,
        quantiles: later.quantiles.map((q) => ({ ...q })),
        lastTime: later.lastTime,
      };
    }
    default:
      return assertNeverAgg(a, path);
  }
  throw invariantError(path, `aggregates of kind '${a.k}'`, `kind '${b.k}'`);
}

function assertNeverAgg(x: never, path: string): never {
  throw invariantError(path, 'known aggregate kind', JSON.stringify(x));
}

function histQuantile(h: HistAgg, q: number): number {
  const rank = q * h.count;
  let cum = 0;
  let i = 0;
  for (; i < h.counts.length; i++) {
    const c = h.counts[i] ?? 0;
    if (c > 0 && cum + c >= rank) break;
    cum += c;
  }
  if (i >= h.counts.length) i = h.counts.length - 1;
  const c = h.counts[i] ?? 0;
  const lastBound = h.bounds[h.bounds.length - 1] ?? 0;
  const lower = i === 0 ? (h.min ?? h.bounds[0] ?? 0) : (h.bounds[i - 1] ?? 0);
  const upper = i === h.bounds.length ? (h.max ?? lastBound) : (h.bounds[i] ?? 0);
  const v = c === 0 ? lower : lower + ((upper - lower) * Math.min(Math.max(rank - cum, 0), c)) / c;
  const lo = h.min ?? Number.NEGATIVE_INFINITY;
  const hi = h.max ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(v, lo), hi);
}

/** Geometric midpoint of bucket `i` at `scale`: `2^((i + 0.5) / 2^scale)`. */
function expMidpoint(i: number, scale: number): number {
  return 2 ** ((i + 0.5) / 2 ** scale);
}

function expQuantile(e: ExpAgg, q: number): number {
  const rank = q * e.count;
  let cum = 0;
  const hit = (c: number): boolean => {
    if (c === 0) return false;
    cum += c;
    return cum >= rank;
  };
  // Ascending value order: most negative bucket first, then zero, then positive.
  for (let j = e.negative.counts.length - 1; j >= 0; j--) {
    if (hit(e.negative.counts[j] ?? 0)) return -expMidpoint(e.negative.offset + j, e.scale);
  }
  if (hit(e.zeroCount)) return 0;
  for (let j = 0; j < e.positive.counts.length; j++) {
    if (hit(e.positive.counts[j] ?? 0)) return expMidpoint(e.positive.offset + j, e.scale);
  }
  const lastJ = e.positive.counts.length - 1;
  return lastJ >= 0 ? expMidpoint(e.positive.offset + lastJ, e.scale) : 0;
}

/** Quantile `q` in [0, 1] of a histogram aggregate, or null when it holds no observations. */
export function quantileOf(a: HistAgg | ExpAgg, q: number): number | null {
  if (a.count === 0) return null;
  return a.k === 'hist' ? histQuantile(a, q) : expQuantile(a, q);
}

const finite: z.ZodNumber = z.number().finite();
const nonNegInt: z.ZodNumber = z.number().int().nonnegative();
const nullableFinite = finite.nullable();
const sumOf = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);

const NumberAggSchema = z.strictObject({
  k: z.literal('number'),
  count: nonNegInt,
  sum: finite,
  min: finite,
  max: finite,
  last: finite,
  lastTime: finite,
});
const CounterAggSchema = z.strictObject({
  k: z.literal('counter'),
  delta: finite,
  resets: nonNegInt,
});
const HistAggSchema = z
  .strictObject({
    k: z.literal('hist'),
    count: nonNegInt,
    sum: finite,
    min: nullableFinite,
    max: nullableFinite,
    bounds: z.array(finite),
    counts: z.array(nonNegInt),
  })
  .refine((h) => h.counts.length === h.bounds.length + 1, { message: 'counts.length === bounds.length + 1' })
  .refine((h) => sumOf(h.counts) === h.count, { message: 'count equal to sum(counts)' });
const ExpSideSchema = z.strictObject({ offset: z.number().int(), counts: z.array(nonNegInt) });
const ExpAggSchema = z
  .strictObject({
    k: z.literal('exp'),
    count: nonNegInt,
    sum: finite,
    min: nullableFinite,
    max: nullableFinite,
    scale: z.number().int(),
    zeroCount: nonNegInt,
    zeroThreshold: finite.nonnegative(),
    positive: ExpSideSchema,
    negative: ExpSideSchema,
  })
  .refine((e) => e.zeroCount + sumOf(e.positive.counts) + sumOf(e.negative.counts) === e.count, {
    message: 'count equal to zeroCount + sum(positive.counts) + sum(negative.counts)',
  });
const SummaryAggSchema = z.strictObject({
  k: z.literal('summary'),
  count: nonNegInt,
  sum: finite,
  quantiles: z.array(z.strictObject({ q: finite, v: finite })),
  lastTime: finite,
});

export const BucketAggSchema: z.ZodType<BucketAgg> = z.union([
  NumberAggSchema,
  CounterAggSchema,
  HistAggSchema,
  ExpAggSchema,
  SummaryAggSchema,
]);
