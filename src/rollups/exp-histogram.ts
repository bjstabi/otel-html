import { z } from 'zod';
import { parseWith } from '../format/validate.js';

const START_SCALE = 20;
const MIN_SCALE = -11;

export type SerializedExpHistogram = {
  maxBuckets: number;
  scale: number;
  zero: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  /** Bucket index of `counts[0]`. */
  offset: number;
  counts: number[];
};

const nonNegInt: z.ZodNumber = z.number().int().nonnegative();

const SerializedExpHistogramSchema: z.ZodType<SerializedExpHistogram> = z
  .strictObject({
    maxBuckets: z.number().int().min(2),
    scale: z.number().int().min(MIN_SCALE).max(START_SCALE),
    zero: nonNegInt,
    count: nonNegInt,
    sum: z.number().finite(),
    min: z.number().finite().nonnegative(),
    max: z.number().finite().nonnegative(),
    offset: z.number().int(),
    counts: z.array(nonNegInt),
  })
  .refine((s) => s.counts.length <= s.maxBuckets, { message: 'counts.length <= maxBuckets' })
  .refine((s) => s.counts.reduce((a, b) => a + b, s.zero) === s.count, {
    message: 'count equal to zero + sum(counts)',
  })
  .refine((s) => s.min <= s.max, { message: 'min <= max' });

/** Largest finite double is below 2^1024, so ~2^11 octaves bound the index range at any scale. */
function indexOf(v: number, scale: number): number {
  return Math.ceil(Math.log2(v) * 2 ** scale) - 1;
}

/**
 * OTel base-2 exponential histogram for non-negative values (durations). Bucket `i` at scale `s`
 * covers `(2^(i/2^s), 2^((i+1)/2^s)]`; zeros have their own bucket. The scale starts at 20 and
 * drops (merging neighbouring buckets) whenever the occupied index span exceeds `maxBuckets`.
 * `quantile` returns a bucket upper bound, so its relative error is below `2^(2^-scale) - 1`.
 */
export class ExpHistogram {
  readonly maxBuckets: number;
  #scale = START_SCALE;
  #zero = 0;
  #count = 0;
  #sum = 0;
  #min = Number.POSITIVE_INFINITY;
  #max = 0;
  #lo = 0;
  #hi = -1;
  #buckets = new Map<number, number>();

  constructor(maxBuckets = 160) {
    if (!Number.isInteger(maxBuckets) || maxBuckets < 2) {
      throw new RangeError(`maxBuckets must be an integer >= 2, got ${maxBuckets}`);
    }
    this.maxBuckets = maxBuckets;
  }

  get scale(): number {
    return this.#scale;
  }
  get count(): number {
    return this.#count;
  }
  get sum(): number {
    return this.#sum;
  }
  get min(): number {
    return this.#count === 0 ? 0 : this.#min;
  }
  get max(): number {
    return this.#max;
  }

  record(v: number): void {
    if (!Number.isFinite(v)) throw new RangeError(`value must be finite, got ${v}`);
    if (v < 0) throw new RangeError(`value must be non-negative, got ${v}`);
    this.#count++;
    this.#sum += v;
    if (v < this.#min) this.#min = v;
    if (v > this.#max) this.#max = v;
    if (v === 0) {
      this.#zero++;
      return;
    }
    this.#addBucket(indexOf(v, this.#scale), 1);
  }

  /** Fold `other` into this histogram (at the coarser of the two scales). */
  merge(other: ExpHistogram): void {
    if (other.#count === 0) return;
    if (this.#count === 0) this.#min = other.#min;
    else this.#min = Math.min(this.#min, other.#min);
    this.#max = Math.max(this.#max, other.#max);
    this.#count += other.#count;
    this.#sum += other.#sum;
    this.#zero += other.#zero;
    while (this.#scale > other.#scale) this.#downscale();
    // Adding may downscale `this`, so the shift is recomputed for every bucket.
    for (const [i, n] of other.#buckets)
      this.#addBucket(Math.floor(i / 2 ** (other.#scale - this.#scale)), n);
  }

  #addBucket(i: number, n: number): void {
    if (this.#buckets.size === 0) {
      this.#lo = i;
      this.#hi = i;
    } else {
      this.#lo = Math.min(this.#lo, i);
      this.#hi = Math.max(this.#hi, i);
    }
    this.#buckets.set(i, (this.#buckets.get(i) ?? 0) + n);
    while (this.#hi - this.#lo + 1 > this.maxBuckets && this.#scale > MIN_SCALE) this.#downscale();
  }

  #downscale(): void {
    const next = new Map<number, number>();
    for (const [i, n] of this.#buckets) {
      const j = Math.floor(i / 2);
      next.set(j, (next.get(j) ?? 0) + n);
    }
    this.#buckets = next;
    this.#lo = Math.floor(this.#lo / 2);
    this.#hi = Math.floor(this.#hi / 2);
    this.#scale--;
  }

  /** `q` in [0, 1]. Returns NaN when empty. */
  quantile(q: number): number {
    if (!(q >= 0 && q <= 1)) throw new RangeError(`q must be between 0 and 1, got ${q}`);
    if (this.#count === 0) return Number.NaN;
    if (q === 0) return this.min;
    const rank = Math.max(1, Math.ceil(q * this.#count));
    if (rank <= this.#zero) return 0;
    let seen = this.#zero;
    for (const i of [...this.#buckets.keys()].sort((a, b) => a - b)) {
      seen += this.#buckets.get(i) ?? 0;
      if (seen >= rank) return Math.min(this.#max, Math.max(this.min, 2 ** ((i + 1) / 2 ** this.#scale)));
    }
    return this.#max;
  }

  toJSON(): SerializedExpHistogram {
    const counts: number[] = [];
    if (this.#buckets.size > 0) {
      for (let i = this.#lo; i <= this.#hi; i++) counts.push(this.#buckets.get(i) ?? 0);
    }
    return {
      maxBuckets: this.maxBuckets,
      scale: this.#scale,
      zero: this.#zero,
      count: this.#count,
      sum: this.#sum,
      min: this.min,
      max: this.#max,
      offset: this.#buckets.size > 0 ? this.#lo : 0,
      counts,
    };
  }

  static from(input: unknown, root = 'expHistogram'): ExpHistogram {
    const s = parseWith(SerializedExpHistogramSchema, input, root);
    const h = new ExpHistogram(s.maxBuckets);
    h.#scale = s.scale;
    h.#zero = s.zero;
    h.#count = s.count;
    h.#sum = s.sum;
    h.#min = s.count === 0 ? Number.POSITIVE_INFINITY : s.min;
    h.#max = s.max;
    s.counts.forEach((n, k) => {
      if (n > 0) h.#addBucket(s.offset + k, n);
    });
    return h;
  }
}
