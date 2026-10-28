import { z } from 'zod';
import { parseWith } from '../format/validate.js';
import type { RelNanos } from '../model/ids.js';
import { floorDiv, mod } from './time-buckets.js';

const BASE_WIDTH_NS = 1_000_000;
const MAX_BUCKETS = 128;

export type SerializedValueBuckets = {
  widthNs: number;
  startNs: number;
  sums: number[];
  counts: number[];
};

const SerializedValueBucketsSchema: z.ZodType<SerializedValueBuckets> = z
  .strictObject({
    widthNs: z.number().int().positive(),
    startNs: z.number().int(),
    sums: z.array(z.number()),
    counts: z.array(z.number().int().nonnegative()),
  })
  .refine((s) => s.widthNs >= BASE_WIDTH_NS && Number.isInteger(Math.log2(s.widthNs / BASE_WIDTH_NS)), {
    message: 'widthNs equal to 1 ms * 2^k',
    path: ['widthNs'],
  })
  .refine((s) => mod(s.startNs, s.widthNs) === 0, {
    message: 'startNs aligned to widthNs',
    path: ['startNs'],
  })
  .refine((s) => s.sums.length === s.counts.length, { message: 'one sum per count', path: ['sums'] })
  .refine((s) => s.counts.length <= MAX_BUCKETS, {
    message: `at most ${MAX_BUCKETS} buckets`,
    path: ['counts'],
  });

/**
 * A sum and a count of float values over time, in buckets of `1 ms * 2^k` aligned to multiples of
 * their width, at most 128 of them. Like `TimeBuckets`, the width doubles when the range grows, so
 * the result depends only on the data, not the insertion order.
 */
export class ValueBuckets {
  #width = BASE_WIDTH_NS;
  #start = 0;
  #sums: number[] = [];
  #counts: number[] = [];

  add(t: RelNanos, v: number): void {
    this.#addAt(t, v, 1);
  }

  /** Adds all of `o`'s buckets; the result equals having added every point to one run. */
  merge(o: ValueBuckets): void {
    if (o.#counts.length === 0) return;
    const last = o.#start + (o.#counts.length - 1) * o.#width;
    this.#fit(o.#start, last, o.#width);
    o.#counts.forEach((n, i) => {
      const sum = o.#sums[i] ?? 0;
      if (n === 0 && sum === 0) return;
      this.#put(o.#start + i * o.#width, sum, n);
    });
  }

  #addAt(t: number, sum: number, n: number): void {
    if (!Number.isFinite(t)) throw new RangeError(`time must be finite, got ${t}`);
    if (!Number.isFinite(sum)) throw new RangeError(`value must be finite, got ${sum}`);
    this.#fit(t, t, BASE_WIDTH_NS);
    this.#put(t, sum, n);
  }

  #put(t: number, sum: number, n: number): void {
    const idx = floorDiv(t - this.#start, this.#width);
    this.#sums[idx] = (this.#sums[idx] ?? 0) + sum;
    this.#counts[idx] = (this.#counts[idx] ?? 0) + n;
  }

  /** Grow (and coarsen if needed, never below `minWidth`) so that `[lo, hi]` has buckets. */
  #fit(loT: number, hiT: number, minWidth: number): void {
    const empty = this.#counts.length === 0;
    let w = Math.max(this.#width, minWidth);
    let lo = empty ? loT : Math.min(this.#start, loT);
    let hi = empty ? hiT : Math.max(this.#start + (this.#counts.length - 1) * this.#width, hiT);
    lo = lo - mod(lo, w);
    hi = hi - mod(hi, w);
    while ((hi - lo) / w + 1 > MAX_BUCKETS) {
      w *= 2;
      lo = lo - mod(lo, w);
      hi = hi - mod(hi, w);
    }
    const len = (hi - lo) / w + 1;
    const sums = new Array<number>(len).fill(0);
    const counts = new Array<number>(len).fill(0);
    this.#counts.forEach((n, j) => {
      const abs = this.#start + j * this.#width;
      const k = (abs - mod(abs, w) - lo) / w;
      sums[k] = (sums[k] ?? 0) + (this.#sums[j] ?? 0);
      counts[k] = (counts[k] ?? 0) + n;
    });
    this.#width = w;
    this.#start = lo;
    this.#sums = sums;
    this.#counts = counts;
  }

  toJSON(): SerializedValueBuckets {
    return { widthNs: this.#width, startNs: this.#start, sums: [...this.#sums], counts: [...this.#counts] };
  }

  static from(input: unknown, root = 'valueBuckets'): ValueBuckets {
    const s = parseWith(SerializedValueBucketsSchema, input, root);
    const b = new ValueBuckets();
    b.#width = s.widthNs;
    b.#start = s.startNs;
    b.#sums = [...s.sums];
    b.#counts = [...s.counts];
    return b;
  }
}
