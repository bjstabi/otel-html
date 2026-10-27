import type { RelNanos } from '../model/ids.js';
import { type SerializedTimeBuckets, TimeBuckets } from './time-buckets.js';

/** Metric rollups count data points. */
export const METRIC_KEYS = ['points'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

/** Per-key counts over time for logs (by severity range) and metrics (points). */
export class SignalCounts<K extends string> {
  readonly buckets: TimeBuckets<K>;

  constructor(source: readonly K[] | TimeBuckets<K>, maxBuckets = 4096) {
    this.buckets = source instanceof TimeBuckets ? source : new TimeBuckets(source, maxBuckets);
  }

  add(t: RelNanos, key: K, n = 1): void {
    this.buckets.add(t, key, n);
  }

  total(key: K): number {
    return this.buckets.total(key);
  }

  toJSON(): SerializedTimeBuckets {
    return this.buckets.toJSON();
  }

  static from<K extends string>(input: unknown, keys: readonly K[], root = 'signalCounts'): SignalCounts<K> {
    return new SignalCounts(TimeBuckets.from(input, keys, root));
  }
}
