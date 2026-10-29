import { describe, expect, test } from 'vitest';
import {
  buildMetricChartOption,
  mergeEchartsOption,
} from '../../src/viewer/components/metric-chart-option.js';
import type { MetricQueryResult, SeriesPoints } from '../../src/viewer/data/metric-query.js';
import { createColorAssigner } from '../../src/viewer/theme/palette.js';

interface Opt {
  legend?: { show: boolean };
  tooltip: { formatter: (p: unknown) => string; axisPointer: { type: string } };
  xAxis: { min?: number; max?: number };
  yAxis: { type: string };
  series: {
    type: string;
    name?: string;
    stack?: string;
    lineStyle?: { width: number };
    showSymbol?: boolean;
    symbol?: string;
    silent?: boolean;
    data: unknown[];
    markLine?: { data: { xAxis: number }[] };
    markArea?: { data: { xAxis: number }[][] };
    itemStyle?: { borderColor?: string };
  }[];
}

const S = 1e9;

/** A line item is `[time, value]`, or `{ value: [time, value], symbol }` when it is drawn as a dot. */
const pointOf = (p: unknown): (number | null)[] =>
  (Array.isArray(p) ? p : (p as { value: (number | null)[] }).value) as (number | null)[];

function series(
  key: string,
  values: (number | null)[],
  unit = 's',
  service: string | null = null,
): SeriesPoints {
  return {
    key,
    label: key,
    group: {},
    unit,
    points: values.map((v, i) => [i * 10 * S, v]),
    resourceService: service,
  };
}

function result(over: Partial<MetricQueryResult> = {}): MetricQueryResult {
  return {
    queryId: 'q1',
    widthNs: 10 * S,
    series: [series('a', [1, 2, 3])],
    exemplars: [],
    heat: null,
    distribution: null,
    notes: [],
    ...over,
  };
}

function build(over: Partial<Parameters<typeof buildMetricChartOption>[0]> = {}): Opt {
  return buildMetricChartOption({
    results: [result()],
    display: 'lines',
    scale: 'linear',
    unit: 's',
    colors: createColorAssigner(),
    marker: null,
    highlightTrace: null,
    exemplars: false,
    size: 'M',
    ...over,
  }) as unknown as Opt;
}

describe('buildMetricChartOption', () => {
  test('two results give two 2px line series, a legend and one value y-axis', () => {
    const o = build({
      results: [result(), result({ queryId: 'q2', series: [series('b', [3, 2, 1])] })],
    });
    expect(o.series.filter((s) => s.type === 'line')).toHaveLength(2);
    expect(o.series.every((s) => s.lineStyle?.width === 2)).toBe(true);
    expect(o.legend?.show).toBe(true);
    expect(o.yAxis.type).toBe('value');
    expect(o.tooltip.axisPointer.type).toBe('cross');
  });

  test('a single series has no legend', () => {
    expect(build().legend?.show).toBe(false);
  });

  test('area stacks and bars group', () => {
    const two = [result({ series: [series('a', [1]), series('b', [2])] })];
    expect(build({ results: two, display: 'area' }).series.every((s) => s.stack === 'total')).toBe(true);
    const bars = build({ results: two, display: 'bars' });
    expect(bars.series.every((s) => s.type === 'bar' && s.stack === undefined)).toBe(true);
  });

  test('log scale uses a log axis and turns non-positive values into null', () => {
    const o = build({ results: [result({ series: [series('a', [0, 5, -1])] })], scale: 'log' });
    expect(o.yAxis.type).toBe('log');
    expect((o.series[0]?.data ?? []).map((p) => pointOf(p)[1])).toEqual([null, 5, null]);
  });

  test('a line point with no non-null neighbour gets a dot; joined points and bars do not', () => {
    const o = build({ results: [result({ series: [series('a', [1, null, 2, 3, null, 4])] })] });
    const line = o.series[0];
    expect(line).toMatchObject({ type: 'line', showSymbol: true, symbol: 'none', silent: true });
    expect(line?.lineStyle?.width).toBe(2);
    const dotted = (line?.data ?? []).map((p) =>
      Array.isArray(p) ? null : (p as { symbol: string }).symbol,
    );
    // 1 (series start, gap after) and 4 (gap before, series end) are isolated; 2-3 join; gaps stay null.
    expect(dotted).toEqual(['circle', null, null, null, null, 'circle']);
    expect((line?.data ?? []).map((p) => pointOf(p)[1])).toEqual([1, null, 2, 3, null, 4]);
    expect(build({ results: [result({ series: [series('a', [7])] })] }).series[0]?.data).toEqual([
      { value: [0, 7], symbol: 'circle', symbolSize: 6 },
    ]);
    const bars = build({ results: [result({ series: [series('a', [1, null, 2])] })], display: 'bars' });
    expect(bars.series[0]?.data).toEqual([
      [0, 1],
      [10 * S, null],
      [20 * S, 2],
    ]);
  });

  test('the x range follows the window, not the data', () => {
    const o = build({ window: { start: 0, end: 100 * S } });
    expect([o.xAxis.min, o.xAxis.max]).toEqual([0, 100 * S]);
  });

  test('exemplars are a ringed scatter series; the highlighted trace gets the accent ring', () => {
    document.documentElement.style.setProperty('--oh-accent', '#112233');
    try {
      const o = build({
        results: [
          result({
            exemplars: [
              { time: 5 * S, value: 1, traceId: 'aa', spanId: 's1', seriesKey: 'a' },
              { time: 15 * S, value: 2, traceId: 'bb', spanId: null, seriesKey: 'a' },
            ],
          }),
        ],
        exemplars: true,
        highlightTrace: 'bb',
      });
      const sc = o.series.find((s) => s.type === 'scatter');
      const items = (sc?.data ?? []) as { traceId: string; itemStyle: { borderColor: string } }[];
      expect(items.map((i) => i.traceId)).toEqual(['aa', 'bb']);
      expect(items[1]?.itemStyle.borderColor).toBe('#112233');
      expect(items[0]?.itemStyle.borderColor).not.toBe('#112233');
    } finally {
      document.documentElement.style.removeProperty('--oh-accent');
    }
  });

  test('no scatter series when exemplars are off', () => {
    const r = result({ exemplars: [{ time: 0, value: 1, traceId: 'aa', spanId: null, seriesKey: 'a' }] });
    expect(build({ results: [r] }).series.some((s) => s.type === 'scatter')).toBe(false);
  });

  test('the marker is a markLine', () => {
    const o = build({ marker: 12 * S });
    expect(o.series[0]?.markLine?.data[0]?.xAxis).toBe(12 * S);
  });

  test('tooltip formats seconds as milliseconds and escapes labels', () => {
    const o = build({ results: [result({ series: [series('<b>x</b>', [0.0021])] })] });
    const html = o.tooltip.formatter([
      { seriesName: '<b>x</b>', seriesType: 'line', value: [0, 0.0021], marker: '', data: [0, 0.0021] },
    ]);
    expect(html).toContain('2.1 ms');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  test('tooltip escapes a markup unit, a rate unit and an exemplar line', () => {
    const unit = '<img src=x onerror=alert(1)>';
    for (const u of [unit, `${unit}/s`]) {
      const o = build({ unit: u, results: [result({ series: [series('a', [2], u)] })] });
      const html = o.tooltip.formatter([
        { seriesName: 'a', seriesType: 'line', value: [0, 2], marker: '', data: [0, 2] },
        {
          seriesName: 'exemplars',
          seriesType: 'scatter',
          value: [0, 2],
          marker: '',
          data: { traceId: 'abcdef0123456789' },
        },
      ]);
      expect(html).not.toContain('<img');
      expect(html).toContain('2 &lt;img src=x onerror=alert(1)&gt;');
      expect(html).toContain('exemplar abcdef01: 2 &lt;img');
    }
  });

  test('heatmap and distribution use their data', () => {
    const heat = build({
      display: 'heatmap',
      results: [
        result({
          heat: {
            bounds: [1, 2],
            cells: [
              [0, 0, 3],
              [10 * S, 2, 1],
            ],
          },
        }),
      ],
    });
    expect(heat.series[0]?.type).toBe('heatmap');
    expect(heat.series[0]?.data).toHaveLength(2);
    const dist = build({
      display: 'distribution',
      results: [result({ distribution: { bounds: [1, 2], counts: [1, 2, 3] } })],
    });
    expect(dist.series[0]?.type).toBe('bar');
    expect(dist.series[0]?.data).toHaveLength(3);
  });
});

describe('selection band and echarts pass-through', () => {
  test('a band is one markArea spanning it, on the first series', () => {
    const o = build({ band: { start: 5 * S, end: 15 * S } });
    const areas = o.series.flatMap((s) => (s.markArea === undefined ? [] : [s.markArea]));
    expect(areas).toHaveLength(1);
    expect(areas[0]?.data).toEqual([[{ xAxis: 5 * S }, { xAxis: 15 * S }]]);
  });

  test('no band draws no markArea', () => {
    expect(build().series.some((s) => s.markArea !== undefined)).toBe(false);
  });

  test('echarts is deep-merged last, so it overrides what the builder set', () => {
    const o = build({ echarts: { yAxis: { type: 'log' }, grid: { top: 99 } } });
    expect(o.yAxis.type).toBe('log');
    expect((o as unknown as { grid: { left: number; top: number } }).grid).toMatchObject({
      left: 56,
      top: 99,
    });
  });
});

describe('mergeEchartsOption', () => {
  test('plain objects merge recursively, anything else replaces, and prototype keys are skipped', () => {
    const extra = JSON.parse('{"a":{"c":[2]},"__proto__":{"polluted":1},"constructor":{"x":1}}') as Record<
      string,
      unknown
    >;
    const merged = mergeEchartsOption({ a: { b: 1, c: [1] } }, extra);
    expect(merged).toEqual({ a: { b: 1, c: [2] } });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect('polluted' in {}).toBe(false);
    expect(Object.hasOwn(merged, 'constructor')).toBe(false);
  });

  test('does not mutate its inputs', () => {
    const base = { a: { b: 1 } };
    mergeEchartsOption(base, { a: { b: 2 } });
    expect(base).toEqual({ a: { b: 1 } });
  });
});
