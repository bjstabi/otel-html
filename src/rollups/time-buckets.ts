import { z } from 'zod';
import { parseWith } from '../format/validate.js';
import { OtelHtmlError } from '../model/errors.js';
import type { RelNanos } from '../model/ids.js';

const BASE_WIDTH_NS = 1_000_000;

export type SerializedTimeBuckets = {
  maxBuckets: number;
  widthNs: number;
  startNs: number;
  keys: string[];
  counts: number[][];
};

const nonNegInt: z.ZodNumber = z.number().int().nonnegative();

const SerializedTimeBucketsSchema: z.ZodType<SerializedTimeBuckets> = z
  .strictObject({
    maxBuckets: z.number().int().min(2),
    widthNs: z.number().int().positive(),
    startNs: z.number().int(),
    keys: z.array(z.string()),
    counts: z.array(z.array(nonNegInt)),
  })
  .refine((s) => s.widthNs >= BASE_WIDTH_NS && Number.isInteger(Math.log2(s.widthNs / BASE_WIDTH_NS)), {
    message: 'widthNs equal to 1 ms * 2^k',
    path: ['widthNs'],
  })
  .refine((s) => mod(s.startNs, s.widthNs) === 0, {
    message: 'startNs aligned to widthNs',
    path: ['startNs'],
  })
  .refine((s) => s.counts.length === s.keys.length, { message: 'one counts row per key', path: ['counts'] })
  .refine((s) => s.counts.every((r) => r.length === (s.counts[0]?.length ?? 0)), {
    message: 'equal-length counts rows',
    path: ['counts'],
  })
  .refine((s) => (s.counts[0]?.length ?? 0) <= s.maxBuckets, {
    message: 'at most maxBuckets buckets',
    path: ['counts'],
  });

/** Exact modulo with a non-negative result (the `%` operator is exact for doubles). */
export function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Exact floor division for integer-valued doubles (avoids rounding a quotient that sits just below an integer). */
export function floorDiv(a: number, b: number): number {
  return (a - mod(a, b)) / b;
}

/**
 * Counts per key over time, in buckets of `1 ms * 2^k` aligned to multiples of their width. When
 * the occupied range exceeds `maxBuckets`, the width doubles and neighbouring buckets are summed,
 * so totals are conserved exactly and the result depends only on the data, not the insertion order.
 */
export class TimeBuckets<K extends string> {
  readonly keys: readonly K[];
  readonly maxBuckets: number;
  #width = BASE_WIDTH_NS;
  #start = 0;
  #len = 0;
  readonly #rows: number[][];
  readonly #keyIndex = new Map<string, number>();

  constructor(keys: readonly K[], maxBuckets = 4096) {
    if (!Number.isInteger(maxBuckets) || maxBuckets < 2) {
      throw new RangeError(`maxBuckets must be an integer >= 2, got ${maxBuckets}`);
    }
    this.keys = keys;
    this.maxBuckets = maxBuckets;
    this.#rows = keys.map(() => []);
    keys.forEach((k, i) => {
      this.#keyIndex.set(k, i);
    });
  }

  get widthNs(): number {
    return this.#width;
  }
  get startNs(): number {
    return this.#start;
  }
  /** Number of buckets. */
  get length(): number {
    return this.#len;
  }

  add(t: RelNanos, key: K, n = 1): void {
    const ki = this.#keyIndex.get(key);
    if (ki === undefined) throw new RangeError(`unknown key ${JSON.stringify(key)}`);
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`n must be a non-negative integer, got ${n}`);
    if (!Number.isFinite(t)) throw new RangeError(`time must be finite, got ${t}`);
    this.#fit(t);
    const row = this.#rows[ki];
    if (row === undefined) return;
    const idx = floorDiv(t - this.#start, this.#width);
    row[idx] = (row[idx] ?? 0) + n;
  }

  counts(key: K): readonly number[] {
    const ki = this.#keyIndex.get(key);
    const row = ki === undefined ? undefined : this.#rows[ki];
    if (row === undefined) throw new RangeError(`unknown key ${JSON.stringify(key)}`);
    return row;
  }

  total(key: K): number {
    return this.counts(key).reduce((a, b) => a + b, 0);
  }

  /** Grow (and coarsen if needed) so that time `t` has a bucket. */
  #fit(t: number): void {
    let w = this.#width;
    let lo = this.#len === 0 ? t : Math.min(this.#start, t);
    let hi = this.#len === 0 ? t : Math.max(this.#start + (this.#len - 1) * w, t);
    lo = lo - mod(lo, w);
    hi = hi - mod(hi, w);
    while ((hi - lo) / w + 1 > this.maxBuckets) {
      w *= 2;
      lo = lo - mod(lo, w);
      hi = hi - mod(hi, w);
    }
    const len = (hi - lo) / w + 1;
    if (this.#len === 0) {
      this.#width = w;
      this.#start = lo;
      this.#len = len;
      for (const row of this.#rows) row.length = len;
      this.#zeroFill();
      return;
    }
    if (w === this.#width) {
      const addLeft = (this.#start - lo) / w;
      for (const row of this.#rows) {
        if (addLeft > 0) row.unshift(...new Array<number>(addLeft).fill(0));
        for (let i = row.length; i < len; i++) row.push(0);
      }
    } else {
      for (const row of this.#rows) {
        const next = new Array<number>(len).fill(0);
        row.forEach((n, j) => {
          const abs = this.#start + j * this.#width;
          const k = (abs - mod(abs, w) - lo) / w;
          next[k] = (next[k] ?? 0) + n;
        });
        row.length = 0;
        row.push(...next);
      }
    }
    this.#width = w;
    this.#start = lo;
    this.#len = len;
  }

  #zeroFill(): void {
    for (const row of this.#rows) row.fill(0);
  }

  toJSON(): SerializedTimeBuckets {
    return {
      maxBuckets: this.maxBuckets,
      widthNs: this.#width,
      startNs: this.#start,
      keys: [...this.keys],
      counts: this.#rows.map((r) => [...r]),
    };
  }

  /** Rebuild from JSON; with `keys`, the stored keys must match exactly. */
  static from<K extends string>(input: unknown, keys: readonly K[], root?: string): TimeBuckets<K>;
  static from(input: unknown): TimeBuckets<string>;
  static from(input: unknown, keys?: readonly string[], root = 'timeBuckets'): TimeBuckets<string> {
    const s = parseWith(SerializedTimeBucketsSchema, input, root);
    if (keys !== undefined && (keys.length !== s.keys.length || keys.some((k, i) => k !== s.keys[i]))) {
      throw new OtelHtmlError('invalid-report', {
        path: `${root}.keys`,
        expected: JSON.stringify(keys),
        actual: JSON.stringify(s.keys),
      });
    }
    const b = new TimeBuckets<string>(s.keys, s.maxBuckets);
    b.#width = s.widthNs;
    b.#start = s.startNs;
    b.#len = s.counts[0]?.length ?? 0;
    s.counts.forEach((row, i) => {
      const dst = b.#rows[i];
      if (dst !== undefined) dst.push(...row);
    });
    return b;
  }
}
