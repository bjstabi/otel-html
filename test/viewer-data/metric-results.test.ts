import { describe, expect, it } from 'vitest';
import type { MetricEntry, SparkBuckets } from '../../src/viewer/data/metric-catalog.js';
import {
  chartWidthNs,
  pickWidthNs,
  resolveMetric,
  upperMedian,
} from '../../src/viewer/data/metric-results.js';
import { NOTES } from '../../src/viewer/data/metric-tables.js';

const spark: SparkBuckets = { widthNs: 0, startNs: 0, sums: [], counts: [] };

const entry = (id: number, over: Partial<MetricEntry> = {}): MetricEntry => ({
  id,
  name: 'm',
  description: '',
  unit: '',
  type: 'gauge',
  temporality: 'unspecified',
  monotonic: false,
  conflicting: false,
  scopes: [],
  attributeKeys: [],
  resources: [],
  series: 0,
  points: 0,
  resets: 0,
  outOfOrder: 0,
  noValue: 0,
  spark,
  ...over,
});

const query = { metric: 'm', kind: null, unit: null } as const;

describe('pickWidthNs', () => {
  it('is the smallest 1 ms x 2^k with at most maxPoints buckets', () => {
    expect(pickWidthNs({ start: 0, end: 3_600e9 }, 600)).toBe(8_192e6);
  });
  it('terminates on a maxPoints under 1 or a window that is not finite', () => {
    expect(pickWidthNs({ start: 0, end: 3_600e9 }, 0)).toBe(1e6);
    expect(pickWidthNs({ start: 0, end: Number.POSITIVE_INFINITY }, 600)).toBe(1e6);
    expect(pickWidthNs({ start: Number.NaN, end: 1 }, 600)).toBe(1e6);
  });
});

describe('chartWidthNs', () => {
  it('is the pick when the interval is no wider', () => {
    expect(chartWidthNs(16_384e6, 10e9)).toBe(16_384e6);
  });
  it('rounds the interval up to a multiple of the pick', () => {
    expect(chartWidthNs(8_192e6, 10e9)).toBe(16_384e6);
    expect(chartWidthNs(256e6, 10e9)).toBe(10_240e6);
  });
});

describe('upperMedian', () => {
  it('is 0 under 8 gaps', () => {
    expect(upperMedian([1, 2, 3, 4, 5, 6, 7])).toBe(0);
  });
  it('is the upper median of an even count', () => {
    expect(upperMedian([1, 2, 3, 4, 5, 6, 7, 8])).toBe(5);
  });
  it('sorts its input without changing it', () => {
    const gaps = [9, 1, 8, 2, 7, 3, 6, 4, 5];
    expect(upperMedian(gaps)).toBe(5);
    expect(gaps[0]).toBe(9);
  });
});

describe('resolveMetric', () => {
  it('finds, misses and reports ambiguity', () => {
    const a = entry(0, { type: 'gauge' });
    const b = entry(1, { type: 'sum', monotonic: true, conflicting: true });
    const catalog = { entries: [a, b], resources: [], scopes: [] };
    expect(resolveMetric(catalog, { ...query, kind: 'sum' })).toEqual({ entry: b });
    expect(resolveMetric(catalog, query)).toEqual({ ambiguous: [a, b] });
    expect(resolveMetric(catalog, { ...query, metric: 'x' })).toEqual({ missing: true });
  });
});

describe('NOTES', () => {
  it('words the browser-side term and the exemplar cap', () => {
    expect(NOTES.residual('a == 1')).toBe('Evaluated in the browser: a == 1');
    expect(NOTES.exemplarsCapped).toBe('exemplars capped: the oldest 5 000 exemplar points are shown');
  });
});
