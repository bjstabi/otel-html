import { describe, expect, test } from 'vitest';
import type { MetricFn } from '../../src/query/metric-query.js';
import type { ExpAgg, HistAgg } from '../../src/rollups/metric-agg.js';
import { applyFns } from '../../src/viewer/data/metric-fn.js';
import { histogramViews } from '../../src/viewer/data/metric-heat.js';
import type { SeriesPoints } from '../../src/viewer/data/metric-results.js';

const S = 1e9;

const line = (key: string, points: [number, number | null][], unit = ''): SeriesPoints => ({
  key,
  label: key,
  group: {},
  unit,
  points,
  resourceService: null,
});

const apply = (series: SeriesPoints[], widthNs: number, ...fns: MetricFn[]) => applyFns(series, widthNs, fns);

const values = (s: SeriesPoints | undefined) => s?.points.map(([, v]) => v);

describe('applyFns', () => {
  test('increase and rate difference consecutive values; the first bucket has no predecessor', () => {
    const g = line('g', [
      [0, 10],
      [10 * S, 30],
      [20 * S, 20],
    ]);
    expect(values(apply([g], 10 * S, { op: 'increase' }).series[0])).toEqual([null, 20, -10]);
    const rate = apply([g], 10 * S, { op: 'rate' }).series[0];
    expect(values(rate)).toEqual([null, 2, -1]);
    expect(rate?.unit).toBe('1/s');
    expect(apply([line('c', [[0, 1]], '{request}')], 10 * S, { op: 'rate' }).series[0]?.unit).toBe(
      '{request}/s',
    );
  });

  test('a gap yields null on both sides of it, and a counter reset is a plain (negative) difference', () => {
    const g = line('g', [
      [0, 5],
      [10 * S, null],
      [20 * S, 8],
      [30 * S, 2],
    ]);
    expect(values(apply([g], 10 * S, { op: 'increase' }).series[0])).toEqual([null, null, null, -6]);
  });

  test('rollup(max, 60000) re-buckets to one minute', () => {
    const g = line(
      'g',
      Array.from({ length: 12 }, (_, i): [number, number] => [i * 10 * S, i]),
    );
    const r = apply([g], 10 * S, { op: 'rollup', agg: 'max', intervalMs: 60_000 });
    expect(r.widthNs).toBe(60 * S);
    expect(r.series[0]?.points).toEqual([
      [0, 5],
      [60 * S, 11],
    ]);
  });

  test('rollup aggregates the non-null values; an interval no wider than the buckets changes nothing', () => {
    const g = line('g', [
      [0, 1],
      [10 * S, null],
      [20 * S, 3],
    ]);
    expect(apply([g], 10 * S, { op: 'rollup', agg: 'avg', intervalMs: 60_000 }).series[0]?.points).toEqual([
      [0, 2],
    ]);
    expect(apply([g], 10 * S, { op: 'rollup', agg: 'sum', intervalMs: 60_000 }).series[0]?.points).toEqual([
      [0, 4],
    ]);
    expect(apply([g], 10 * S, { op: 'rollup', agg: 'min', intervalMs: 60_000 }).series[0]?.points).toEqual([
      [0, 1],
    ]);
    const same = apply([g], 10 * S, { op: 'rollup', agg: 'max', intervalMs: 10_000 });
    expect(same.widthNs).toBe(10 * S);
    expect(same.series[0]?.points).toEqual(g.points);
  });

  test('a non-positive rollup interval and a bad top n are usage errors', () => {
    const g = line('g', [[0, 1]]);
    expect(() => apply([g], S, { op: 'rollup', agg: 'max', intervalMs: 0 })).toThrow();
    expect(() => apply([g], S, { op: 'top', n: 0, by: 'avg' })).toThrow();
  });

  test('top keeps the largest series, bottom the smallest; series without values rank last', () => {
    const a = line('a', [[0, 10]]);
    const b = line('b', [[0, 90]]);
    const c = line('c', [[0, 50]]);
    const empty = line('e', [[0, null]]);
    expect(apply([a, b, c], S, { op: 'top', n: 1, by: 'avg' }).series.map((s) => s.key)).toEqual(['b']);
    expect(apply([a, b, c], S, { op: 'bottom', n: 2, by: 'max' }).series.map((s) => s.key)).toEqual([
      'a',
      'c',
    ]);
    expect(apply([empty, a, b], S, { op: 'top', n: 3, by: 'last' }).series.map((s) => s.key)).toEqual([
      'b',
      'a',
      'e',
    ]);
  });

  test('top scores by avg, max or last of the non-null points', () => {
    const rising = line('rising', [
      [0, 1],
      [S, 9],
    ]);
    const falling = line('falling', [
      [0, 10],
      [S, 2],
    ]);
    const top = (by: 'avg' | 'max' | 'last') =>
      apply([rising, falling], S, { op: 'top', n: 1, by }).series[0]?.key;
    expect(top('max')).toBe('falling');
    expect(top('last')).toBe('rising');
    expect(top('avg')).toBe('falling');
  });
});

const hist = (counts: number[], bounds = [10, 100]): HistAgg => ({
  k: 'hist',
  count: counts.reduce((a, b) => a + b, 0),
  sum: 0,
  min: null,
  max: null,
  bounds,
  counts,
});

const exp = (offset: number, counts: number[], zeroCount: number, neg: number[]): ExpAgg => ({
  k: 'exp',
  count: counts.reduce((x, y) => x + y, 0) + zeroCount + neg.reduce((x, y) => x + y, 0),
  sum: 0,
  min: null,
  max: null,
  scale: 0,
  zeroCount,
  zeroThreshold: 0,
  positive: { offset, counts },
  negative: { offset: 0, counts: neg },
});

describe('histogramViews', () => {
  test('explicit histograms with one bounds set: cells per bucket and the window distribution', () => {
    const v = histogramViews([hist([6, 13, 11])], 0, 10 * S);
    expect(v.distribution).toEqual({ bounds: [10, 100], counts: [6, 13, 11] });
    expect(v.heat).toEqual({
      bounds: [10, 100],
      widthNs: 10 * S,
      cells: [
        [0, 0, 6],
        [0, 1, 13],
        [0, 2, 11],
      ],
    });
  });

  test('time buckets are placed from b0 and empty or missing buckets add no cells', () => {
    const v = histogramViews([undefined, hist([0, 2, 0]), undefined, hist([1, 0, 0])], 3, 10 * S);
    expect(v.heat?.cells).toEqual([
      [40 * S, 1, 2],
      [60 * S, 0, 1],
    ]);
    expect(v.distribution?.counts).toEqual([1, 2, 0]);
  });

  test('no histogram at all gives no heatmap and no distribution', () => {
    expect(histogramViews([], 0, S)).toEqual({ heat: null, distribution: null });
    expect(histogramViews([undefined], 0, S)).toEqual({ heat: null, distribution: null });
  });

  test('exponential histograms use the merged layout across buckets', () => {
    const v = histogramViews([exp(0, [1, 2], 1, [1]), exp(1, [4], 0, [])], 0, 10 * S);
    // Layout: (-2, -1], zero, (1, 2], (2, 4].
    expect(v.distribution).toEqual({ bounds: [-1, 0, 2], counts: [1, 1, 1, 6] });
    expect(v.heat?.cells).toEqual([
      [0, 0, 1],
      [0, 1, 1],
      [0, 2, 1],
      [0, 3, 2],
      [10 * S, 3, 4],
    ]);
  });

  test('the heat width is the width the cells sit on, whatever a rollup does to the series', () => {
    const fine = 8.192 * S;
    const v = histogramViews(
      Array.from({ length: 15 }, () => hist([0, 1, 0])),
      0,
      fine,
    );
    expect(v.heat?.widthNs).toBe(fine);
    expect(v.heat?.cells).toHaveLength(15);
    expect(v.heat?.cells.filter(([t]) => t < 60 * S)).toHaveLength(8);
    // The series side is rolled up independently by applyFns.
    const rolled = apply([line('g', [[0, 1]])], fine, { op: 'rollup', agg: 'avg', intervalMs: 60_000 });
    expect(rolled.widthNs).toBe(60 * S);
  });
});
