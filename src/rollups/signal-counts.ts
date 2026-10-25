import type { RelNanos } from '../model/ids.js';
import { type SerializedTimeBuckets, TimeBuckets } from './time-buckets.js';

/** Log severity range buckets (OTel SeverityNumber ranges), in display order. */
export const LOG_SEVERITY_KEYS = ['unspecified', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogSeverityKey = (typeof LOG_SEVERITY_KEYS)[number];

/** Metric rollups count data points. */
export const METRIC_KEYS = ['points'] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

/** Severity ranges: 1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17-20 error, 21-24 fatal; 0 unspecified. */
export function severityKey(n: number): LogSeverityKey {
  if (!Number.isInteger(n) || n < 0 || n > 24)
    throw new RangeError(`severity number must be 0..24, got ${n}`);
  if (n === 0) return 'unspecified';
  return LOG_SEVERITY_KEYS[1 + Math.floor((n - 1) / 4)] ?? 'unspecified';
}

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
