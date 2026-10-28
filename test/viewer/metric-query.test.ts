import { describe, expect, test } from 'vitest';
import type { AnyValue, Attributes } from '../../src/model/anyvalue.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { MetricPointRecord, ResourceRecord } from '../../src/model/records.js';
import { type BucketAgg, type HistAgg, mergeAgg, quantileOf } from '../../src/rollups/metric-agg.js';
import type { MetricEntry, SeriesDef } from '../../src/rollups/metric-catalog.js';
import { ValueBuckets } from '../../src/rollups/value-buckets.js';
import { evaluateFormula, formulaWidth, parseFormula } from '../../src/viewer/data/metric-formula.js';
import type { LevelData, LoadedMetric, LoadedSeries } from '../../src/viewer/data/metric-load.js';
import {
  chartWidthNs,
  DEFAULT_SHOW,
  defaultShow,
  kindOf,
  type MetricQuery,
  pickLevel,
  pointIntervalNs,
  resolveMetric,
  runMetricQuery,
  runMetricQueryAtWidth,
  SHOW_BY_KIND,
  showOptions,
} from '../../src/viewer/data/metric-query.js';
import { medianMs } from '../../test-support/median-ms.js';

declare const process: { env: { OTEL_HTML_PERF_FACTOR?: string } }; // provided by vitest; the viewer project has no node types
const PERF_FACTOR = Number(process.env.OTEL_HTML_PERF_FACTOR ?? '1');

const S = 1e9;
const str = (value: string): AnyValue => ({ kind: 'string', value });
const attrs = (o: Record<string, string>): Attributes =>
  new Map(Object.entries(o).map(([k, v]) => [k, str(v)]));
const resource = (service: string): ResourceRecord => ({
  attributes: attrs({ 'service.name': service }),
  droppedAttributesCount: 0,
  schemaUrl: '',
});
const SCOPE = { name: 'lib', version: '1', attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' };

function entry(over: Partial<MetricEntry> & Pick<MetricEntry, 'type'>): MetricEntry {
  return {
    id: 0,
    name: 'm',
    description: '',
    unit: 'By',
    temporality: 'delta',
    monotonic: false,
    conflicting: false,
    scopes: ['lib'],
    attributeKeys: [],
    resources: [0],
    series: 0,
    folded: 0,
    resets: 0,
    outOfOrder: 0,
    noValue: 0,
    points: 0,
    spark: new ValueBuckets(),
    ...over,
  };
}

interface SeriesSpec {
  service?: string;
  attributes?: Record<string, string>;
  /** Attributes with non-string values; wins over `attributes`. */
  attributeMap?: Attributes;
  bounds?: number[];
  other?: boolean;
  /** bucket index → aggregate */
  buckets: [number, BucketAgg][];
}

function metric(
  e: MetricEntry,
  specs: SeriesSpec[],
  widthNs = 10 * S,
  level = 0,
  more: Partial<LoadedMetric> = {},
): LoadedMetric {
  const series: LoadedSeries[] = specs.map((s, id) => {
    const def: SeriesDef = {
      id,
      resource: s.other === true ? -1 : id,
      scope: s.other === true ? -1 : 0,
      attributes: s.attributeMap ?? attrs(s.attributes ?? {}),
      bounds: s.bounds ?? null,
      other: s.other === true,
    };
    return {
      def,
      resource: s.other === true ? null : resource(s.service ?? 'svc'),
      scope: s.other === true ? null : SCOPE,
    };
  });
  const lvl: LevelData = {
    level,
    widthNs,
    series: new Map(
      specs.map((s, id) => [id, { t: s.buckets.map(([t]) => t), a: s.buckets.map(([, a]) => a) }]),
    ),
  };
  return {
    entry: { ...e, series: specs.length },
    series,
    levels: [lvl],
    exemplars: [],
    fromSegments: false,
    ...more,
  };
}

const counter = (delta: number, resets = 0): BucketAgg => ({ k: 'counter', delta, resets });
const gauge = (v: number, count = 1): BucketAgg => ({
  k: 'number',
  count,
  sum: v * count,
  min: v,
  max: v,
  last: v,
  lastTime: 0,
});
const hist = (counts: number[], bounds = [10, 100]): HistAgg => ({
  k: 'hist',
  count: counts.reduce((a, b) => a + b, 0),
  sum: counts.reduce((a, c, i) => a + c * (bounds[i] ?? 200), 0),
  min: 1,
  max: 500,
  bounds,
  counts,
});

const query = (over: Partial<MetricQuery> & Pick<MetricQuery, 'show'>): MetricQuery => ({
  id: 'a',
  metric: 'm',
  kind: null,
  unit: null,
  by: [],
  where: null,
  fn: [],
  alias: null,
  hidden: false,
  ...over,
});

const WINDOW = { start: 0, end: 59 * S };
const values = (r: { series: { points: [number, number | null][] }[] }, i = 0): (number | null)[] =>
  (r.series[i]?.points ?? []).map(([, v]) => v);

describe('tables', () => {
  test('kinds, show options and defaults', () => {
    expect(kindOf(entry({ type: 'sum', monotonic: true }))).toBe('counter');
    expect(kindOf(entry({ type: 'sum', monotonic: false }))).toBe('number');
    expect(kindOf(entry({ type: 'gauge' }))).toBe('number');
    expect(kindOf(entry({ type: 'histogram' }))).toBe('hist');
    expect(kindOf(entry({ type: 'exponentialHistogram' }))).toBe('exp');
    expect(kindOf(entry({ type: 'summary' }))).toBe('summary');
    expect(SHOW_BY_KIND.counter).toEqual(['rate', 'increase', 'sum']);
    expect(DEFAULT_SHOW).toMatchObject({ counter: 'rate', number: 'avg', hist: 'p95', exp: 'p95' });
  });
});

describe('runMetricQuery', () => {
  const ctr = entry({ type: 'sum', monotonic: true, temporality: 'cumulative', unit: '{request}' });

  test('counter rate over 10 s buckets with delta 20 is 2/s', () => {
    const m = metric(ctr, [{ buckets: [0, 1, 2, 3, 4, 5].map((t) => [t, counter(20)]) }]);
    const r = runMetricQuery(m, query({ show: 'rate' }), WINDOW, 600);
    expect(r.widthNs).toBe(10 * S);
    expect(values(r)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(r.series[0]?.points.map(([t]) => t)).toEqual([0, 10, 20, 30, 40, 50].map((x) => x * S));
    expect(r.series[0]?.unit).toBe('{request}/s');
  });

  test('increase is the delta, sum is the running total since the run start, gaps are null', () => {
    const m = metric(ctr, [
      {
        buckets: [
          [0, counter(5)],
          [1, counter(20)],
          [3, counter(20)],
        ],
      },
    ]);
    const w = { start: 10 * S, end: 39 * S };
    expect(values(runMetricQuery(m, query({ show: 'increase' }), w, 600))).toEqual([20, null, 20]);
    expect(values(runMetricQuery(m, query({ show: 'sum' }), w, 600))).toEqual([25, null, 45]);
  });

  test('gauge last by everything over two series sums their last values', () => {
    const m = metric(entry({ type: 'gauge' }), [
      { buckets: [[0, gauge(100)]] },
      { buckets: [[0, gauge(50)]] },
    ]);
    const r = runMetricQuery(m, query({ show: 'last', fn: [] }), { start: 0, end: 9 * S }, 600);
    expect(values(r)).toEqual([150]);
    expect(values(runMetricQuery(m, query({ show: 'avg' }), { start: 0, end: 9 * S }, 600))).toEqual([75]);
    expect(values(runMetricQuery(m, query({ show: 'max' }), { start: 0, end: 9 * S }, 600))).toEqual([100]);
  });

  test('histogram p95 is quantileOf the merged buckets', () => {
    const a = hist([5, 10, 2]);
    const b = hist([1, 3, 9]);
    const m = metric(entry({ type: 'histogram', temporality: 'delta' }), [
      { bounds: [10, 100], buckets: [[0, a]] },
      { bounds: [10, 100], buckets: [[0, b]] },
    ]);
    const merged = mergeAgg(a, b, 'test');
    if (merged.k !== 'hist') throw new Error('expected hist');
    const r = runMetricQuery(m, query({ show: 'p95' }), { start: 0, end: 9 * S }, 600);
    expect(values(r)).toEqual([quantileOf(merged, 0.95)]);
    // One bounds set: the key is the group's alone, so formulas align it with other kinds' queries.
    expect(r.series[0]?.key).toBe('[]');
    expect(r.distribution).toEqual({ bounds: [10, 100], counts: [6, 13, 11] });
    expect(r.heat?.cells).toEqual([
      [0, 0, 6],
      [0, 1, 13],
      [0, 2, 11],
    ]);
  });

  test('exponential histograms merge; heat and distribution use the merged layout', () => {
    const exp = (offset: number, counts: number[], zeroCount: number, neg: number[]): BucketAgg => ({
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
    const a = exp(0, [1, 2], 1, [1]);
    const b = exp(1, [4], 0, []);
    const m = metric(entry({ type: 'exponentialHistogram' }), [{ buckets: [[0, a]] }, { buckets: [[1, b]] }]);
    const r = runMetricQuery(m, query({ show: 'count' }), { start: 0, end: 19 * S }, 600);
    expect(values(r)).toEqual([5, 4]);
    // Layout: (-2, -1], zero, (1, 2], (2, 4].
    expect(r.distribution).toEqual({ bounds: [-1, 0, 2], counts: [1, 1, 1, 6] });
    expect(r.heat?.cells).toEqual([
      [0, 0, 1],
      [0, 1, 1],
      [0, 2, 1],
      [0, 3, 2],
      [10 * S, 3, 4],
    ]);
  });

  test('histograms with different bounds are separate lines with a note', () => {
    const m = metric(entry({ type: 'histogram' }), [
      { bounds: [10, 100], buckets: [[0, hist([1, 1, 1])]] },
      { bounds: [5], buckets: [[0, hist([1, 1], [5])]] },
    ]);
    const r = runMetricQuery(m, query({ show: 'count' }), { start: 0, end: 9 * S }, 600);
    expect(r.series).toHaveLength(2);
    expect(r.notes).toContain('histogram bounds differ');
    expect(new Set(r.series.map((s) => s.key)).size).toBe(2);
    expect(r.series.map((s) => s.label)).toEqual(['m · bounds [10, 100]', 'm · bounds [5]']);
    expect(r.distribution).toBeNull();
  });

  test('by service gives one series per value, labelled by it', () => {
    const m = metric(ctr, [
      { service: 'checkout', buckets: [[0, counter(10)]] },
      { service: 'cart', buckets: [[0, counter(30)]] },
      { service: 'checkout', buckets: [[0, counter(10)]] },
    ]);
    const r = runMetricQuery(
      m,
      query({ show: 'increase', by: ['resource.attributes["service.name"]'] }),
      { start: 0, end: 9 * S },
      600,
    );
    expect(r.series.map((s) => [s.label, values({ series: [s] })])).toEqual([
      ['cart', [30]],
      ['checkout', [20]],
    ]);
    expect(r.series[1]?.group).toEqual({ 'resource.attributes["service.name"]': 'checkout' });
    expect(r.series[1]?.resourceService).toBe('checkout');
  });

  test('where keeps only matching series', () => {
    const m = metric(ctr, [
      { attributes: { 'http.route': '/pay' }, buckets: [[0, counter(10)]] },
      { attributes: { 'http.route': '/cart' }, buckets: [[0, counter(30)]] },
    ]);
    const r = runMetricQuery(
      m,
      query({ show: 'increase', where: 'attributes["http.route"] == "/pay" and metric.name == "m"' }),
      { start: 0, end: 9 * S },
      600,
    );
    expect(values(r)).toEqual([10]);
  });

  test('time paths in where fail with invalid-ottl', () => {
    const m = metric(ctr, [{ buckets: [[0, counter(10)]] }]);
    const run = () =>
      runMetricQuery(m, query({ show: 'rate', where: 'datapoint.time_unix_nano > 5' }), WINDOW, 600);
    expect(run).toThrow(OtelHtmlError);
    expect(run).toThrow(/time filters use the time range/);
    const byTime = () =>
      runMetricQuery(m, query({ show: 'rate', by: ['start_time_unix_nano'] }), WINDOW, 600);
    expect(byTime).toThrow(/time filters use the time range/);
    expect(() => runMetricQuery(m, query({ show: 'rate', by: ['span.name'] }), WINDOW, 600)).toThrow(
      /datapoint path/,
    );
  });

  test('top 1 keeps the largest group', () => {
    const m = metric(ctr, [
      { service: 'a', buckets: [[0, counter(10)]] },
      { service: 'b', buckets: [[0, counter(90)]] },
      { service: 'c', buckets: [[0, counter(50)]] },
    ]);
    const r = runMetricQuery(
      m,
      query({
        show: 'increase',
        by: ['resource.attributes["service.name"]'],
        fn: [{ op: 'top', n: 1, by: 'avg' }],
      }),
      { start: 0, end: 9 * S },
      600,
    );
    expect(r.series.map((s) => s.label)).toEqual(['b']);
  });

  test('rollup(max, 60000) re-buckets to one minute', () => {
    const m = metric(entry({ type: 'gauge' }), [
      { buckets: Array.from({ length: 12 }, (_, i): [number, BucketAgg] => [i, gauge(i)]) },
    ]);
    const r = runMetricQuery(
      m,
      query({ show: 'avg', fn: [{ op: 'rollup', agg: 'max', intervalMs: 60_000 }] }),
      { start: 0, end: 119 * S },
      600,
    );
    expect(r.widthNs).toBe(60 * S);
    expect(r.series[0]?.points).toEqual([
      [0, 5],
      [60 * S, 11],
    ]);
  });

  test('ƒ increase and rate difference consecutive values', () => {
    const m = metric(entry({ type: 'gauge' }), [
      {
        buckets: [
          [0, gauge(10)],
          [1, gauge(30)],
          [2, gauge(20)],
        ],
      },
    ]);
    const w = { start: 0, end: 29 * S };
    expect(values(runMetricQuery(m, query({ show: 'last', fn: [{ op: 'increase' }] }), w, 600))).toEqual([
      null,
      20,
      -10,
    ]);
    expect(values(runMetricQuery(m, query({ show: 'last', fn: [{ op: 'rate' }] }), w, 600))).toEqual([
      null,
      2,
      -1,
    ]);
  });

  test('level pick: 1 h window with maxPoints 600 is level 1 (8.192 s)', () => {
    const levels = [0, 1, 2, 3].map((level) => ({ level, widthNs: 1.024e9 * 8 ** level, series: new Map() }));
    expect(pickLevel(levels, { start: 0, end: 3600 * S }, 600)?.level).toBe(1);
    expect(pickLevel(levels, { start: 0, end: 3600 * S }, 2)?.level).toBe(3);
    expect(pickLevel(levels.slice(2), { start: 0, end: 10 * S }, 600)?.level).toBe(2);
    expect(pickLevel([], { start: 0, end: 10 * S }, 600)).toBeNull();
  });

  describe("level pick never goes finer than the points' interval", () => {
    const L0 = 1.024e9;
    /** A gauge (value 1) with points every `everyS` seconds over an hour, at levels 0-3 of the 1.024 s × 8^k ladder. */
    const ladderSeries = (everyS: number): Map<number, number[]> => {
      const t0: number[] = [];
      for (let s = 0; s < 3600; s += everyS) t0.push(Math.floor((s * S) / L0));
      return new Map([0, 1, 2, 3].map((k) => [k, [...new Set(t0.map((t) => Math.floor(t / 8 ** k)))]]));
    };
    const ladder = (specs: { everyS: number; route: string }[]): LoadedMetric => {
      const base = metric(
        entry({ type: 'gauge' }),
        specs.map((x) => ({ attributes: { route: x.route }, buckets: [] })),
      );
      const perSeries = specs.map((x) => ladderSeries(x.everyS));
      const levels: LevelData[] = [0, 1, 2, 3].map((level) => ({
        level,
        widthNs: L0 * 8 ** level,
        series: new Map(
          perSeries.map((byLevel, id) => {
            const t = byLevel.get(level) ?? [];
            return [id, { t, a: t.map(() => gauge(1)) }];
          }),
        ),
      }));
      return { ...base, levels };
    };
    const hour = { start: 0, end: 3600 * S };

    test('10 s points: the median interval is 10 level-0 buckets (10.24 s)', () => {
      expect(pointIntervalNs(ladder([{ everyS: 10, route: '/a' }]), null)).toBe(10 * L0);
    });

    test('10 s points over 1 h at 1100 points: 16.384 s (two level-1 buckets, ~220 points), not 8.192 s', () => {
      const m = ladder([{ everyS: 10, route: '/a' }]);
      // R1 alone picks level 1 (8.192 s), finer than the 10.24 s interval.
      expect(pickLevel(m.levels, hour, 1100)?.level).toBe(1);
      expect(chartWidthNs(m, query({ show: 'avg' }), hour, 1100)).toBe(L0 * 16);
      // R1 wider than the interval wins: 6 points over the hour need level 3.
      expect(chartWidthNs(m, query({ show: 'avg' }), hour, 6)).toBe(L0 * 512);
    });

    test('runMetricQuery charts a line: consecutive buckets all hold a value', () => {
      const r = runMetricQuery(ladder([{ everyS: 10, route: '/a' }]), query({ show: 'avg' }), hour, 1100);
      expect(r.widthNs).toBe(L0 * 16);
      const values = r.series[0]?.points.map((p) => p[1]) ?? [];
      expect(values.length).toBe(220);
      expect(values.every((v) => v === 1)).toBe(true);
    });

    test('a run too short for a coarser level merges level 0 up to the interval (100 s of 10 s points: 10.24 s)', () => {
      const short = ladder([{ everyS: 10, route: '/a' }]);
      const levels = short.levels.slice(0, 1).map((l) => ({
        ...l,
        series: new Map(
          [...l.series].map(([id, x]) => [
            id,
            { t: x.t.filter((t) => t * L0 < 100 * S), a: x.a.filter((_, i) => (x.t[i] ?? 0) * L0 < 100 * S) },
          ]),
        ),
      }));
      const r = runMetricQuery(
        { ...short, levels },
        query({ show: 'avg' }),
        { start: 0, end: 100 * S },
        1100,
      );
      expect(r.widthNs).toBe(L0 * 10);
      expect(r.series[0]?.points).toEqual(Array.from({ length: 10 }, (_, k) => [k * L0 * 10, 1]));
    });

    test('a few points say nothing about the interval: under 8 gaps R1 alone picks', () => {
      const m = metric(entry({ type: 'gauge' }), [
        { buckets: [0, 30, 60, 90, 120, 150, 180, 210].map((t): [number, BucketAgg] => [t, gauge(1)]) },
      ]);
      expect(pointIntervalNs(m, null)).toBe(0);
      const nine = metric(entry({ type: 'gauge' }), [
        { buckets: [0, 3, 6, 9, 12, 15, 18, 21, 24].map((t): [number, BucketAgg] => [t, gauge(1)]) },
      ]);
      expect(pointIntervalNs(nine, null)).toBe(30 * S);
    });

    test('an even sample takes the upper median', () => {
      // Gaps of 1,1,1,1,3,3,3,3 buckets (10 s wide): the lower median would be 10 s, the upper is 30 s.
      const m = metric(entry({ type: 'gauge' }), [
        { buckets: [0, 1, 2, 3, 4, 7, 10, 13, 16].map((t): [number, BucketAgg] => [t, gauge(1)]) },
      ]);
      expect(pointIntervalNs(m, null)).toBe(30 * S);
    });

    test('the interval comes from the series the where keeps', () => {
      const m = ladder([
        { everyS: 1, route: '/dense' },
        { everyS: 10, route: '/sparse' },
      ]);
      expect(pointIntervalNs(m, 'attributes["route"] == "/sparse"')).toBe(10 * L0);
      expect(pointIntervalNs(m, 'attributes["route"] == "/dense"')).toBe(L0);
      const sparse = runMetricQuery(
        m,
        query({ show: 'avg', where: 'attributes["route"] == "/sparse"' }),
        hour,
        1100,
      );
      const dense = runMetricQuery(
        m,
        query({ show: 'avg', where: 'attributes["route"] == "/dense"' }),
        hour,
        1100,
      );
      expect(sparse.widthNs).toBe(L0 * 16);
      expect(dense.widthNs).toBe(L0 * 8);
    });

    test('a formula re-run gets exactly the width it asks for', () => {
      const m = ladder([{ everyS: 10, route: '/a' }]);
      expect(runMetricQueryAtWidth(m, query({ show: 'avg' }), hour, L0 * 8).widthNs).toBe(L0 * 8);
      expect(runMetricQueryAtWidth(m, query({ show: 'avg' }), hour, L0 * 64).widthNs).toBe(L0 * 64);
    });

    test('a / b with a = rollup(20 s) over 10 s points re-runs b at exactly 20 s', () => {
      const m = ladder([{ everyS: 10, route: '/a' }]);
      const a = runMetricQuery(
        m,
        query({ id: 'a', show: 'avg', fn: [{ op: 'rollup', agg: 'avg', intervalMs: 20_000 }] }),
        hour,
        1100,
      );
      const b0 = runMetricQuery(m, query({ id: 'b', show: 'avg' }), hour, 1100);
      const ast = parseFormula('a / b');
      const width = formulaWidth(
        ast,
        new Map([
          ['a', a],
          ['b', b0],
        ]),
      );
      expect(width).toBe(20 * S);
      const b = runMetricQueryAtWidth(m, query({ id: 'b', show: 'avg' }), hour, width);
      expect(b.widthNs).toBe(20 * S);
      const f = evaluateFormula(
        ast,
        new Map([
          ['a', a],
          ['b', b],
        ]),
        'f',
      );
      expect(f.widthNs).toBe(20 * S);
      const fv = values(f);
      expect(fv.length).toBe(180);
      expect(fv.every((v) => v === 1)).toBe(true);
    });
  });

  test('folded series plus an attribute where give the partial note', () => {
    const m = metric(entry({ ...ctr, folded: 500 }), [
      { attributes: { 'http.route': '/pay' }, buckets: [[0, counter(10)]] },
      { other: true, buckets: [[0, counter(30)]] },
    ]);
    const w = { start: 0, end: 9 * S };
    const r = runMetricQuery(
      m,
      query({ show: 'increase', where: 'attributes["http.route"] == "/pay"' }),
      w,
      600,
    );
    expect(r.notes).toContain('partial: 500 points folded into other');
    const byName = runMetricQuery(m, query({ show: 'increase', where: 'metric.name == "m"' }), w, 600);
    expect(byName.notes.some((n) => n.startsWith('partial'))).toBe(false);
    expect(values(byName)).toEqual([40]);
  });

  test('a summary query at level 2 notes its quantiles; summaries are not combined', () => {
    const sum = (v: number): BucketAgg => ({
      k: 'summary',
      count: 4,
      sum: 4 * v,
      quantiles: [
        { q: 0.5, v },
        { q: 0.99, v: v * 2 },
      ],
      lastTime: 0,
    });
    const m = metric(
      entry({ type: 'summary' }),
      [
        { attributes: { k: 'x' }, buckets: [[0, sum(1)]] },
        { attributes: { k: 'y' }, buckets: [[0, sum(3)]] },
      ],
      1.024e9 * 64,
      2,
    );
    const r = runMetricQuery(m, query({ show: DEFAULT_SHOW.summary }), { start: 0, end: 9 * S }, 600);
    expect(r.notes).toContain('summary quantiles from the last point per bucket');
    expect(r.notes).toContain('summaries are not combined');
    expect(r.series.map((s) => values({ series: [s] }))).toEqual([[2], [6]]);
    expect(r.series.map((s) => s.label)).toEqual(['k=x', 'k=y']);
  });

  test('resets, unfinished reports and points without values are noted', () => {
    const m = metric(entry({ ...ctr, noValue: 3 }), [{ buckets: [[0, counter(10, 1)]] }], 10 * S, 0, {
      fromSegments: true,
    });
    const r = runMetricQuery(m, query({ show: 'rate' }), { start: 0, end: 9 * S }, 600);
    expect(r.notes).toEqual(
      expect.arrayContaining([
        '1 counter reset in range',
        'report unfinished: series merged from flush segments',
        '3 points had no value',
      ]),
    );
  });

  test('an unknown show fails with usage', () => {
    const m = metric(ctr, [{ buckets: [[0, counter(10)]] }]);
    expect(() => runMetricQuery(m, query({ show: 'p95' }), WINDOW, 600)).toThrow(/show/);
  });

  test('exemplars in the window carry their series key', () => {
    const base = metric(ctr, [{ buckets: [[0, counter(10)]] }]);
    const m: LoadedMetric = {
      ...base,
      exemplars: [
        { series: 0, time: 5 * S, value: 3, traceId: 't1', spanId: 's1', attributes: new Map() },
        { series: 0, time: 500 * S, value: 3, traceId: null, spanId: null, attributes: new Map() },
      ],
    };
    const r = runMetricQuery(m, query({ show: 'rate' }), { start: 0, end: 9 * S }, 600);
    expect(r.exemplars).toEqual([
      { time: 5 * S, value: 3, traceId: 't1', spanId: 's1', seriesKey: r.series[0]?.key },
    ]);
  });

  test('perf: 1,000 series × 450 buckets, query change under 150 ms median', () => {
    const specs: SeriesSpec[] = Array.from({ length: 1000 }, (_, i) => ({
      service: `svc-${i % 10}`,
      attributes: { 'http.route': `/r${i % 20}` },
      buckets: Array.from({ length: 450 }, (_, t): [number, BucketAgg] => [t, counter(t + i)]),
    }));
    const m = metric(ctr, specs, 8.192e9, 1);
    const w = { start: 0, end: 450 * 8.192e9 - 1 };
    const q = query({
      show: 'rate',
      by: ['resource.attributes["service.name"]'],
      where: 'attributes["http.route"] != "/r3"',
      fn: [{ op: 'top', n: 5, by: 'avg' }],
    });
    const { result, ms } = medianMs(() => runMetricQuery(m, q, w, 600));
    expect(result.series).toHaveLength(5);
    expect(ms).toBeLessThan(150 * PERF_FACTOR);
  });
});

describe('review fixes', () => {
  const ctr = entry({ type: 'sum', monotonic: true, temporality: 'cumulative', unit: '{request}' });
  const svc = 'resource.attributes["service.name"]';

  test('counter sum counts series whose data all precede the window', () => {
    const m = metric(ctr, [
      { buckets: [[0, counter(100)]] },
      {
        buckets: [
          [0, counter(5)],
          [3, counter(7)],
        ],
      },
    ]);
    const w = { start: 30 * S, end: 39 * S };
    expect(values(runMetricQuery(m, query({ show: 'sum' }), w, 600))).toEqual([112]);
    // Panning keeps the same total for the same bucket.
    expect(values(runMetricQuery(m, query({ show: 'sum' }), { start: 0, end: 39 * S }, 600))).toEqual([
      105,
      null,
      null,
      112,
    ]);
    // A group with nothing in the window is not drawn.
    const by = runMetricQuery(m, query({ show: 'sum', by: ['attributes["k"]'] }), w, 600);
    expect(by.series).toHaveLength(1);
  });

  test('counter sum by group: pre-window-only groups are not drawn, pre-window members join their group', () => {
    const m = metric(ctr, [
      { attributes: { k: 'x' }, buckets: [[0, counter(100)]] },
      { attributes: { k: 'y' }, buckets: [[1, counter(10)]] },
      {
        attributes: { k: 'y' },
        buckets: [
          [0, counter(1)],
          [3, counter(2)],
        ],
      },
    ]);
    const r = runMetricQuery(
      m,
      query({ show: 'sum', by: ['attributes["k"]'] }),
      { start: 30 * S, end: 39 * S },
      600,
    );
    expect(r.series.map((x) => [x.label, values({ series: [x] })])).toEqual([['y', [13]]]);
  });

  test('a formula over a rolled-up operand re-runs the other at the rollup width', () => {
    const g = metric(entry({ type: 'gauge' }), [
      { buckets: Array.from({ length: 12 }, (_, i): [number, BucketAgg] => [i, gauge(i + 1)]) },
    ]);
    const w = { start: 0, end: 119 * S };
    const a = runMetricQuery(
      g,
      query({ id: 'a', show: 'max', fn: [{ op: 'rollup', agg: 'max', intervalMs: 60_000 }] }),
      w,
      600,
    );
    const b0 = runMetricQuery(g, query({ id: 'b', show: 'max' }), w, 600);
    const ast = parseFormula('a / b');
    const width = formulaWidth(
      ast,
      new Map([
        ['a', a],
        ['b', b0],
      ]),
    );
    expect(width).toBe(60 * S);
    const b = runMetricQueryAtWidth(g, query({ id: 'b', show: 'max' }), w, width);
    expect(b.widthNs).toBe(60 * S);
    expect(values(b)).toEqual([6, 12]);
    const f = evaluateFormula(
      ast,
      new Map([
        ['a', a],
        ['b', b],
      ]),
      'f',
    );
    expect(values(f)).toEqual([1, 1]);
  });

  test('a formula over a rollup re-runs at 60 s from the real ladder (coarsest level no wider)', () => {
    const e = entry({ type: 'gauge' });
    const window = { start: 0, end: 120 * S };
    const at = (level: number, n: number, v: (i: number) => number): LevelData => {
      const widthNs = 1.024e9 * 8 ** level;
      const lm = metric(
        e,
        [{ buckets: Array.from({ length: n }, (_, i): [number, BucketAgg] => [i, gauge(v(i))]) }],
        widthNs,
        level,
      );
      const [l] = lm.levels;
      if (l === undefined) throw new Error('level');
      return l;
    };
    // Levels 0 and 2 hold junk: a wrong level pick shows in the values.
    const levels = [at(0, 118, () => 1000), at(1, 15, (i) => i), at(2, 2, () => 1000)];
    const m: LoadedMetric = { ...metric(e, [{ buckets: [] }]), levels };
    const a = runMetricQuery(
      m,
      query({ id: 'a', show: 'max', fn: [{ op: 'rollup', agg: 'max', intervalMs: 60_000 }] }),
      window,
      20,
    );
    expect(a.widthNs).toBe(60 * S);
    expect(values(a)).toEqual([7, 14]);
    const plain = runMetricQuery(m, query({ id: 'b', show: 'max' }), window, 20);
    const width = formulaWidth(
      parseFormula('a - b'),
      new Map([
        ['a', a],
        ['b', plain],
      ]),
    );
    expect(width).toBe(60 * S);
    // 8.192 s buckets 0–7 start before 60 s, 8–14 after: assigned by start time, as rollup does.
    const b = runMetricQueryAtWidth(m, query({ id: 'b', show: 'max' }), window, width);
    expect(b.widthNs).toBe(60 * S);
    expect(values(b)).toEqual([7, 14]);
    const f = evaluateFormula(
      parseFormula('a - b + 1'),
      new Map([
        ['a', a],
        ['b', b],
      ]),
      'f',
    );
    expect(f.series[0]?.points).toEqual([
      [0, 1],
      [60 * S, 1],
    ]);
  });

  test('group keys are typed and name their paths; "other" and "(none)" values stay apart', () => {
    const int1: Attributes = new Map([['k', { kind: 'int', value: 1n }]]);
    const m = metric(entry({ ...ctr, folded: 9 }), [
      { attributes: { k: 'other' }, buckets: [[0, counter(1)]] },
      { attributes: { k: '(none)' }, buckets: [[0, counter(2)]] },
      { attributes: { k: '1' }, buckets: [[0, counter(4)]] },
      { attributeMap: int1, buckets: [[0, counter(8)]] },
      { buckets: [[0, counter(16)]] },
      { other: true, buckets: [[0, counter(32)]] },
    ]);
    const w = { start: 0, end: 9 * S };
    const r = runMetricQuery(m, query({ show: 'increase', by: ['attributes["k"]'] }), w, 600);
    expect(r.series).toHaveLength(6);
    expect(new Set(r.series.map((s) => s.key)).size).toBe(6);
    expect(r.series.map((s) => values({ series: [s] })[0]).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([
      1, 2, 4, 8, 16, 32,
    ]);
    const byOther = runMetricQuery(m, query({ show: 'increase', by: ['attributes["j"]'] }), w, 600);
    const keysK = new Set(r.series.map((s) => s.key));
    expect(byOther.series.some((s) => keysK.has(s.key))).toBe(false);
  });

  test('bounds differing between groups give a note for the missing heatmap', () => {
    const m = metric(entry({ type: 'histogram' }), [
      { service: 'a', bounds: [10, 100], buckets: [[0, hist([1, 1, 1])]] },
      { service: 'b', bounds: [5], buckets: [[0, hist([1, 1], [5])]] },
    ]);
    const r = runMetricQuery(m, query({ show: 'count', by: [svc] }), { start: 0, end: 9 * S }, 600);
    expect(r.heat).toBeNull();
    expect(r.distribution).toBeNull();
    expect(r.notes).toContain('histogram bounds differ across series: no heatmap or distribution');
  });

  test('flags in where or by is rejected as a per-point field', () => {
    const m = metric(ctr, [{ buckets: [[0, counter(1)]] }]);
    const w = { start: 0, end: 9 * S };
    for (const q of [
      query({ show: 'rate', where: 'flags == 1' }),
      query({ show: 'rate', by: ['datapoint.flags'] }),
    ]) {
      const run = () => runMetricQuery(m, q, w, 600);
      expect(run).toThrow(OtelHtmlError);
      expect(run).toThrow(/flags is a per-point field/);
    }
  });

  test('defaultShow gives a concrete option for every kind', () => {
    const sum: BucketAgg = {
      k: 'summary',
      count: 1,
      sum: 1,
      quantiles: [
        { q: 0.5, v: 1 },
        { q: 0.99, v: 2 },
      ],
      lastTime: 0,
    };
    const s = metric(entry({ type: 'summary' }), [{ buckets: [[0, sum]] }]);
    expect(defaultShow(s)).toBe('q0.99');
    expect(showOptions(s)).toContain(defaultShow(s));
    expect(defaultShow(metric(entry({ type: 'summary' }), []))).toBe('count');
    const c = metric(ctr, [{ buckets: [[0, counter(1)]] }]);
    expect(defaultShow(c)).toBe('rate');
    expect(showOptions(c)).toContain(defaultShow(c));
  });
});

describe('resolveMetric', () => {
  const entries = [
    entry({ id: 0, name: 'a', type: 'gauge', unit: 'By' }),
    entry({ id: 1, name: 'b', type: 'gauge', unit: 'By', conflicting: true }),
    entry({ id: 2, name: 'b', type: 'sum', unit: 'By', conflicting: true }),
  ];
  const catalog = { entries: () => entries };
  const kindQ = (metric: string, kind: MetricPointRecord['type'] | null) =>
    resolveMetric(catalog, query({ metric, kind, show: 'avg' }));
  test('by name, then kind and unit when conflicting', () => {
    expect(kindQ('a', null)).toEqual({ entry: entries[0] });
    expect(kindQ('b', null)).toEqual({ ambiguous: [entries[1], entries[2]] });
    expect(kindQ('b', 'sum')).toEqual({ entry: entries[2] });
    expect(kindQ('zzz', null)).toEqual({ missing: true });
  });
});
