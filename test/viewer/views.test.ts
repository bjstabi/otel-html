import { describe, expect, test } from 'vitest';
import { FacetCounts } from '../../src/rollups/facets.js';
import { RedSeries } from '../../src/rollups/red.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import type { SpanQueryResult, SpanRow } from '../../src/viewer/data/span-query.js';
import { createColorAssigner } from '../../src/viewer/theme/palette.js';
import {
  durationBins,
  GROUPED_VIEWS,
  groupSlices,
  resolveCssVars,
  VIEW_BUILDERS,
} from '../../src/viewer/traces/views.js';

interface Datum {
  name: string;
  value: number;
  itemStyle: { color: string };
}

function result(services: number, spans: Partial<Record<string, number>> = {}): SpanQueryResult {
  const facets = new FacetCounts(100, 50, ['service.name']);
  // service-0 has the most spans (services, services-1, ...): counts 9, 8, ... 1.
  for (let s = 0; s < services; s++) {
    for (let i = 0; i < services - s; i++) facets.add('service.name', `service-${s}`);
  }
  for (const [name, n] of Object.entries(spans))
    for (let i = 0; i < (n ?? 0); i++) facets.add('span.name', name);
  return {
    rows: [],
    total: facets.total('service.name'),
    facets,
    buckets: new TimeBuckets(['ok', 'error', 'unset'], 64),
    red: new RedSeries(64),
    partial: null,
  };
}

function data(option: unknown): Datum[] {
  const series = (option as { series: { data: Datum[] }[] }).series;
  return series[0]?.data ?? [];
}

describe('VIEW_BUILDERS.toplist', () => {
  test('9 services give 7 bars plus Other, coloured through the assigner', () => {
    const colors = createColorAssigner();
    const option = VIEW_BUILDERS.toplist(result(9), { groupBy: 'service.name', colors });
    const d = data(option);
    expect(d.map((x) => x.name)).toEqual([
      'service-0',
      'service-1',
      'service-2',
      'service-3',
      'service-4',
      'service-5',
      'service-6',
      'Other',
    ]);
    expect(d.map((x) => x.value)).toEqual([9, 8, 7, 6, 5, 4, 3, 2 + 1]);
    d.slice(0, 7).forEach((x, i) => {
      expect(x.itemStyle.color).toBe(`var(--oh-series-${colors.colorFor(`service-${i}`) + 1})`);
    });
    expect(d[7]?.itemStyle.color).toBe('var(--oh-series-other)');
  });

  test('an entity keeps its colour when the filtered set reorders the groups', () => {
    const colors = createColorAssigner();
    const first = data(VIEW_BUILDERS.pie(result(3), { groupBy: 'service.name', colors }));
    const second = data(VIEW_BUILDERS.pie(result(2), { groupBy: 'service.name', colors }));
    const colour = (d: Datum[], n: string): string | undefined =>
      d.find((x) => x.name === n)?.itemStyle.color;
    expect(colour(second, 'service-1')).toBe(colour(first, 'service-1'));
  });

  test('without a group-by key it groups by service', () => {
    const d = data(VIEW_BUILDERS.bar(result(2), { groupBy: null, colors: createColorAssigner() }));
    expect(d.map((x) => x.name)).toEqual(['service-0', 'service-1']);
  });
});

describe('groupSlices', () => {
  test('Other is everything not in the top 7 and is omitted when zero', () => {
    const colors = createColorAssigner();
    expect(groupSlices(result(7).facets, 'service.name', colors).map((s) => s.name)).not.toContain('Other');
    const nine = groupSlices(result(9).facets, 'service.name', colors);
    expect(nine.at(-1)).toMatchObject({ name: 'Other', value: 3, other: true });
  });
});

describe('every chart view builds', () => {
  test.each(Object.keys(VIEW_BUILDERS) as (keyof typeof VIEW_BUILDERS)[])('%s', (view) => {
    const option = VIEW_BUILDERS[view](result(3), { groupBy: 'service.name', colors: createColorAssigner() });
    expect(option).toBeTypeOf('object');
  });

  test('only the grouped views use the group-by key', () => {
    expect([...GROUPED_VIEWS].sort()).toEqual(['bar', 'pie', 'table', 'toplist', 'treemap']);
  });

  test('pointplot plots the returned spans by start and duration, errors with their own series', () => {
    const row = (start: number, dur: number, error: boolean): SpanRow =>
      ({
        span: { start, end: start + dur, status: { code: error ? 2 : 1, message: '' }, name: 'n' },
        service: 's',
        resource: 'r',
        durationNs: dur,
      }) as unknown as SpanRow;
    const r = { ...result(1), rows: [row(1, 10, false), row(2, 20, true)] };
    const option = VIEW_BUILDERS.pointplot(r, { groupBy: null, colors: createColorAssigner() });
    const series = (option as { series: { name: string; data: number[][] }[] }).series;
    expect(series.map((s) => [s.name, s.data.length])).toEqual([
      ['ok', 1],
      ['error', 1],
    ]);
  });
});

describe('resolveCssVars', () => {
  test('replaces var(--x) strings anywhere in an option and leaves the input untouched', () => {
    const input = { a: [{ c: 'var(--oh-series-1)' }], b: 3, d: 'plain' };
    const out = resolveCssVars(input, (name) => (name === '--oh-series-1' ? '#2a78d6' : ''));
    expect(out).toEqual({ a: [{ c: '#2a78d6' }], b: 3, d: 'plain' });
    expect(input.a[0]?.c).toBe('var(--oh-series-1)');
  });
});

describe('durationBins', () => {
  const row = (d: number): SpanRow => ({ durationNs: d }) as unknown as SpanRow;

  test('log-spaced bins cover every duration exactly once', () => {
    const rows = [1, 10, 100, 1000, 1000, 5000].map(row);
    const bins = durationBins(rows, 4);
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(6);
    expect(bins[0]?.fromNs).toBeLessThanOrEqual(1);
    expect(bins.at(-1)?.toNs).toBeGreaterThan(5000);
    for (let i = 1; i < bins.length; i++) expect(bins[i]?.fromNs).toBe(bins[i - 1]?.toNs);
  });

  test('empty input and a single distinct value are handled', () => {
    expect(durationBins([], 4)).toEqual([]);
    const one = durationBins([row(7), row(7)], 4);
    expect(one.reduce((a, b) => a + b.count, 0)).toBe(2);
  });
});
