import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { MetricPageState, MetricQuery } from '../../src/query/metric-query.js';
import type { MetricCatalogData, MetricEntry } from '../../src/viewer/data/metric-catalog.js';
import type { MetricQueryRequest, MetricQueryResult } from '../../src/viewer/data/metric-results.js';
import { useMetricQueries } from '../../src/viewer/metrics/use-metric-query.js';
import { baseManifest, dataSourceOf } from './dashboard-shell.js';

const WINDOW = { start: 0, end: 60e9 };

const entry = (id: number, name: string, over: Partial<MetricEntry> = {}): MetricEntry => ({
  id,
  name,
  description: '',
  unit: '',
  type: 'gauge',
  temporality: 'unspecified',
  monotonic: false,
  conflicting: false,
  scopes: [],
  attributeKeys: [],
  resources: [0],
  series: 1,
  points: 1,
  resets: 0,
  outOfOrder: 0,
  noValue: 0,
  spark: { widthNs: 1, startNs: 0, sums: [], counts: [] },
  ...over,
});

const query = (id: string, metric: string, over: Partial<MetricQuery> = {}): MetricQuery => ({
  id,
  metric,
  kind: null,
  unit: null,
  show: 'avg',
  by: [],
  where: null,
  fn: [],
  alias: null,
  hidden: false,
  ...over,
});

const state = (over: Partial<MetricPageState>): MetricPageState => ({
  queries: [],
  formulas: [],
  display: 'lines',
  scale: 'linear',
  split: false,
  exemplars: false,
  ...over,
});

const result = (queryId: string, widthNs: number): MetricQueryResult => ({
  queryId,
  widthNs,
  series: [
    {
      key: 'k',
      label: queryId,
      group: {},
      unit: '',
      points: [
        [0, 1],
        [widthNs, 2],
      ],
      resourceService: null,
    },
  ],
  exemplars: [],
  heat: null,
  distribution: null,
  notes: [],
});

function source(entries: MetricEntry[], widths: Record<string, number>) {
  const requests: MetricQueryRequest[] = [];
  const shown: number[] = [];
  const catalog: MetricCatalogData = { entries, resources: [], scopes: [] };
  const ds = {
    ...dataSourceOf(baseManifest),
    metricCatalog: () => Promise.resolve(catalog),
    metricShowOptions: (id: number) => {
      shown.push(id);
      return Promise.resolve(['avg', 'max']);
    },
    metricQuery: (req: MetricQueryRequest) => {
      requests.push(req);
      return Promise.resolve(result(req.query.id, req.widthNs ?? widths[req.query.id] ?? 1e6));
    },
  };
  return { ds, requests, shown };
}

describe('useMetricQueries', () => {
  test('runs each visible query through metricQuery with the state exemplars', async () => {
    const { ds, requests, shown } = source([entry(0, 'a.m'), entry(1, 'b.m')], {});
    const s = state({ queries: [query('a', 'a.m'), query('b', 'b.m')], exemplars: true });
    const { result: r } = renderHook(() => useMetricQueries(ds, s, WINDOW));
    await waitFor(() => expect(r.current.results.size).toBe(2));
    expect(requests.map((q) => [q.query.id, q.entry.id, q.exemplars, q.maxPoints])).toEqual([
      ['a', 0, true, 600],
      ['b', 1, true, 600],
    ]);
    expect(shown.sort()).toEqual([0, 1]);
    expect(r.current.showOptions.get('a')).toEqual(['avg', 'max']);
  });

  test('a formula over operands at 10 s and 20 s re-runs the 10 s one at 20 s', async () => {
    const { ds, requests } = source([entry(0, 'a.m'), entry(1, 'b.m')], { a: 10e9, b: 20e9 });
    const s = state({
      queries: [query('a', 'a.m'), query('b', 'b.m')],
      formulas: [{ id: 'f1', expr: 'a + b', alias: null, hidden: false }],
    });
    const { result: r } = renderHook(() => useMetricQueries(ds, s, WINDOW));
    await waitFor(() => expect(r.current.results.has('f1')).toBe(true));
    const reruns = requests.filter((q) => q.widthNs !== undefined);
    expect(reruns.map((q) => [q.query.id, q.widthNs])).toEqual([['a', 20e9]]);
    expect(r.current.results.get('f1')?.widthNs).toBe(20e9);
  });

  test('an ambiguous metric gives the existing error text', async () => {
    const { ds } = source([entry(0, 'm', { type: 'gauge' }), entry(1, 'm', { type: 'sum' })], {});
    const { result: r } = renderHook(() =>
      useMetricQueries(ds, state({ queries: [query('a', 'm')] }), WINDOW),
    );
    await waitFor(() => expect(r.current.errors.get('a')).toBe('m has 2 definitions: choose one'));
  });

  test('a missing metric gives the existing error text', async () => {
    const { ds } = source([entry(0, 'x')], {});
    const { result: r } = renderHook(() =>
      useMetricQueries(ds, state({ queries: [query('a', 'nope')] }), WINDOW),
    );
    await waitFor(() => expect(r.current.errors.get('a')).toBe('no metric named nope in this report'));
  });
});
