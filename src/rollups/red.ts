import { z } from 'zod';
import { parseWith } from '../format/validate.js';
import { OtelHtmlError } from '../model/errors.js';
import type { RelNanos } from '../model/ids.js';
import { ExpHistogram, type SerializedExpHistogram } from './exp-histogram.js';
import { floorDiv, type SerializedTimeBuckets, TimeBuckets } from './time-buckets.js';

const RED_KEYS = ['count', 'errors'] as const;
type RedKey = (typeof RED_KEYS)[number];

const SerializedRedSchema = z.strictObject({
  buckets: z.unknown(),
  histograms: z.array(z.unknown()),
});

export type SerializedRed = {
  buckets: SerializedTimeBuckets;
  /** Aligned with the buckets; `null` where a bucket is empty. */
  histograms: (SerializedExpHistogram | null)[];
};

/**
 * Requests / errors / latency over time: request and error counts per time bucket plus one
 * exponential histogram per bucket. Everything coarsens together.
 */
export class RedSeries {
  #tb: TimeBuckets<RedKey>;
  /** Histograms keyed by absolute bucket index (`floor(t / widthNs)`) at the current width. */
  #hists = new Map<number, ExpHistogram>();

  constructor(maxBuckets = 4096) {
    this.#tb = new TimeBuckets(RED_KEYS, maxBuckets);
  }

  get widthNs(): number {
    return this.#tb.widthNs;
  }
  get startNs(): number {
    return this.#tb.startNs;
  }
  get counts(): readonly number[] {
    return this.#tb.counts('count');
  }
  get errors(): readonly number[] {
    return this.#tb.counts('errors');
  }
  /** Per-bucket duration histograms aligned with `counts`; `undefined` where a bucket is empty. */
  get histograms(): readonly (ExpHistogram | undefined)[] {
    const base = floorDiv(this.#tb.startNs, this.#tb.widthNs);
    return Array.from({ length: this.#tb.length }, (_, i) => this.#hists.get(base + i));
  }

  add(t: RelNanos, durationNs: number, isError: boolean): void {
    const before = this.#tb.widthNs;
    const wasEmpty = this.#tb.length === 0;
    this.#tb.add(t, 'count');
    if (isError) this.#tb.add(t, 'errors');
    const after = this.#tb.widthNs;
    if (!wasEmpty && after !== before) this.#rekey(after / before);
    const abs = floorDiv(t, after);
    let h = this.#hists.get(abs);
    if (h === undefined) {
      h = new ExpHistogram();
      this.#hists.set(abs, h);
    }
    h.record(Math.max(0, durationNs));
  }

  #rekey(factor: number): void {
    const next = new Map<number, ExpHistogram>();
    for (const [abs, h] of this.#hists) {
      const k = Math.floor(abs / factor);
      const into = next.get(k);
      if (into === undefined) next.set(k, h);
      else into.merge(h);
    }
    this.#hists = next;
  }

  toJSON(): SerializedRed {
    return {
      buckets: this.#tb.toJSON(),
      histograms: this.histograms.map((h) => (h === undefined ? null : h.toJSON())),
    };
  }

  static from(input: unknown, root = 'red'): RedSeries {
    const s = parseWith(SerializedRedSchema, input, root);
    const tb = TimeBuckets.from(s.buckets, RED_KEYS, `${root}.buckets`);
    if (s.histograms.length !== tb.length) {
      throw new OtelHtmlError('invalid-report', {
        path: `${root}.histograms`,
        expected: `${tb.length} entries`,
        actual: String(s.histograms.length),
      });
    }
    const r = new RedSeries();
    r.#tb = tb;
    const base = floorDiv(tb.startNs, tb.widthNs);
    s.histograms.forEach((h, i) => {
      if (h === null) return;
      const hist = ExpHistogram.from(h, `${root}.histograms[${i}]`);
      if (hist.count !== (tb.counts('count')[i] ?? 0)) {
        throw new OtelHtmlError('invalid-report', {
          path: `${root}.histograms[${i}].count`,
          expected: String(tb.counts('count')[i] ?? 0),
          actual: String(hist.count),
        });
      }
      r.#hists.set(base + i, hist);
    });
    return r;
  }
}
