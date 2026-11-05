import { describe, expect, test } from 'vitest';
import { FacetCounts } from '../../src/rollups/facets.js';
import { RedSeries } from '../../src/rollups/red.js';
import { GroupDurations } from '../../src/rollups/span-rollups.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { formatDuration } from '../../src/semconv/formatters.js';
import {
  bar,
  groupSlices as groupSlicesShared,
  measuredSlices,
  pie,
  toplist,
  treemap,
} from '../../src/viewer/components/facet-views.js';
import type { SpanQueryResult, SpanRow } from '../../src/viewer/data/span-query.js';
import { createColorAssigner } from '../../src/viewer/theme/palette.js';
import {
  binsOnAxis,
  durationAxis,
  durationBins,
  GROUPED_VIEWS,
  groupSlices,
  paddedAxis,
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
    groups: null,
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
  test('a real group literally named Other is shown as "Other (value)" but keeps its real key and colour', () => {
    const facets = new FacetCounts(100, 50, ['service.name']);
    for (const [name, n] of [
      ['Other', 5],
      ['b', 4],
    ] as const)
      for (let i = 0; i < n; i++) facets.add('service.name', name);
    const colors = createColorAssigner();
    const slices = groupSlices(facets, 'service.name', colors);
    expect(slices.map((s) => [s.name, s.key, s.other])).toEqual([
      ['Other (value)', 'Other', false],
      ['b', 'b', false],
    ]);
    expect(slices[0]?.color).toBe(`var(--oh-series-${colors.colorFor('Other') + 1})`);
  });

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

  test('durationAxis with a range puts lo and hi on the first and last edge exactly', () => {
    const edges = durationAxis([2e6, 5e6, 9e6].map(row), 24, { lo: 1e6, hi: 1e7 });
    expect(edges).toHaveLength(25);
    expect(edges[0]).toBe(1e6);
    expect(edges.at(-1)).toBe(1e7);
    for (let i = 1; i < edges.length; i++) expect(edges[i]).toBeGreaterThan(edges[i - 1] ?? Number.NaN);
  });

  test('durationAxis edges are integer nanoseconds, pinned or not, and non-decreasing', () => {
    for (const edges of [
      durationAxis([1000, 1873, 5000, 9e6].map(row), 24),
      durationAxis([7].map(row), 4),
      durationAxis([2e6].map(row), 24, { lo: 1e6, hi: 1e7 }),
      durationAxis([2e6].map(row), 24, { lo: 1873.8174228603843 }),
    ]) {
      expect(edges.every(Number.isInteger)).toBe(true);
      for (let i = 1; i < edges.length; i++)
        expect(edges[i]).toBeGreaterThanOrEqual(edges[i - 1] ?? Number.NaN);
    }
  });

  test('paddedAxis outer edges are integers too, so a fractional bound pads to whole nanoseconds', () => {
    const rows = [1000, 5000, 9e6].map(row);
    for (const range of [
      { lo: 1873.8174228603843 },
      { hi: 7777.7 },
      { lo: 1873.8174228603843, hi: 7777.7 },
    ]) {
      const edges = paddedAxis(rows, 24, range);
      expect(edges).toHaveLength(25);
      expect(edges.every(Number.isInteger)).toBe(true);
      for (let i = 1; i < edges.length; i++)
        expect(edges[i]).toBeGreaterThanOrEqual(edges[i - 1] ?? Number.NaN);
    }
  });

  test('durationAxis pins a degenerate range exactly and stays non-decreasing', () => {
    for (const range of [
      { lo: 5, hi: 5 },
      { lo: 0.5, hi: 1 },
    ]) {
      const edges = durationAxis([2e6].map(row), 24, range);
      expect(edges).toHaveLength(25);
      expect(edges[0]).toBe(Math.round(range.lo));
      expect(edges.at(-1)).toBe(Math.round(range.hi));
      for (let i = 1; i < edges.length; i++)
        expect(edges[i]).toBeGreaterThanOrEqual(edges[i - 1] ?? Number.NaN);
    }
    const below = durationAxis([2e6].map(row), 24, { hi: 1e3 });
    expect(below.at(-1)).toBe(1e3);
    for (let i = 1; i < below.length; i++)
      expect(below[i]).toBeGreaterThanOrEqual(below[i - 1] ?? Number.NaN);
  });

  test('durationAxis with a range exists without rows', () => {
    const hiOnly = durationAxis([], 24, { hi: 1e6 });
    expect(hiOnly).toHaveLength(25);
    expect(hiOnly.at(-1)).toBe(1e6);
    const loOnly = durationAxis([], 24, { lo: 5e5 });
    expect(loOnly).toHaveLength(25);
    expect(loOnly[0]).toBe(5e5);
    const both = durationAxis([], 24, { lo: 1e3, hi: 1e6 });
    expect(both).toHaveLength(25);
    expect([both[0], both.at(-1)]).toEqual([1e3, 1e6]);
  });

  test('durationAxis rounds a sub-nanosecond lo to the first edge and spaces the interior from 1 ns', () => {
    const edges = durationAxis([row(50)], 4, { lo: 0.5, hi: 1e4 });
    expect(edges[0]).toBe(1);
    expect(edges[1]).toBeGreaterThan(1);
    expect(edges.at(-1)).toBe(1e4);
  });

  test('binsOnAxis puts a duration equal to an edge in the upper bin', () => {
    const bins = binsOnAxis([row(10), row(100)], [0, 10, 100, 1000]);
    expect(bins.map((b) => b.count)).toEqual([0, 1, 1]);
  });

  test('binsOnAxis counts rows into given edges and clamps outliers', () => {
    const bins = binsOnAxis([5, 50, 500, -1].map(row), [0, 10, 100]);
    expect(bins).toEqual([
      { fromNs: 0, toNs: 10, count: 2 },
      { fromNs: 10, toNs: 100, count: 2 },
    ]);
  });

  test('durationBins equals binsOnAxis over durationAxis', () => {
    const rows = [1, 10, 100, 1000, 1000, 5000].map(row);
    expect(durationBins(rows, 4)).toEqual(binsOnAxis(rows, durationAxis(rows, 4)));
    expect(durationAxis([], 4)).toEqual([]);
  });
});

describe('facet views over a log facet set', () => {
  test('toplist, bar, pie and treemap work with only { facets }', () => {
    const facets = new FacetCounts(100, 50, ['severity']);
    for (let i = 0; i < 3; i++) facets.add('severity', 'ERROR');
    facets.add('severity', 'INFO');
    const ctx = { groupBy: 'severity', colors: createColorAssigner() };
    const names = (o: unknown): string[] =>
      (o as { series: { data: { name: string }[] }[] }).series[0]?.data.map((d) => d.name) ?? [];
    expect((toplist({ facets }, ctx) as { yAxis: { data: string[] } }).yAxis.data).toEqual(['ERROR', 'INFO']);
    expect(names(bar({ facets }, ctx))).toEqual(['ERROR', 'INFO']);
    expect(names(pie({ facets }, ctx))).toEqual(['ERROR', 'INFO']);
    expect(names(treemap({ facets }, ctx))).toEqual(['ERROR', 'INFO']);
    expect(groupSlices(facets, 'severity', ctx.colors)).toHaveLength(2);
  });
});

test('views re-exports the shared groupSlices', () => {
  expect(groupSlices).toBe(groupSlicesShared);
});

describe('measured slices', () => {
  function measured(): { facets: FacetCounts; groups: GroupDurations } {
    const facets = new FacetCounts(100, 50, ['service.name']);
    const groups = new GroupDurations(1000);
    for (const [name, ns] of [
      ['a', 30e6],
      ['b', 50e6],
    ] as const) {
      facets.add('service.name', name);
      groups.add(name, ns);
    }
    return { facets, groups };
  }

  test('measuredSlices ranks groups by the measure, no Other slice', () => {
    const { groups } = measured();
    const slices = measuredSlices(groups, 'duration.max', createColorAssigner());
    expect(slices.map((s) => s.key)).toEqual(['b', 'a']);
    expect(slices.some((s) => s.other)).toBe(false);
  });

  test('a rare slow group outranks many frequent fast ones', () => {
    const groups = new GroupDurations(1000);
    for (let g = 0; g < 8; g++) for (let i = 0; i < 5; i++) groups.add(`fast${g}`, 1e6);
    groups.add('deploy', 600e9);
    const slices = measuredSlices(groups, 'duration.max', createColorAssigner());
    expect(slices).toHaveLength(7);
    expect(slices[0]?.key).toBe('deploy');
  });

  test('colours are assigned to the groups drawn only, in rank order', () => {
    const groups = new GroupDurations(1000);
    for (let g = 0; g < 12; g++) groups.add(`g${g}`, (g + 1) * 1e6);
    const asked: string[] = [];
    const colors = {
      colorFor: (name: string): number => {
        asked.push(name);
        return asked.length - 1;
      },
    };
    const slices = measuredSlices(groups, 'duration.max', colors);
    expect(slices).toHaveLength(7);
    expect(asked).toEqual(slices.map((s) => s.key));
    expect(asked[0]).toBe('g11');
  });

  test('toplist with a duration measure formats its labels as durations', () => {
    const { facets, groups } = measured();
    const option = toplist(
      { facets, groups },
      { groupBy: 'service.name', colors: createColorAssigner(), measure: 'duration.max' },
    ) as {
      xAxis: { minInterval?: number; axisLabel: { formatter: (v: number) => string } };
    };
    expect(option.xAxis.axisLabel.formatter(50e6)).toBe(formatDuration(50e6));
    expect(option.xAxis.minInterval).toBeUndefined();
  });
});
