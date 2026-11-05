import { describe, expect, test } from 'vitest';
import type { MetricEntry } from '../../src/rollups/metric-catalog.js';
import type { MetricQuery } from '../../src/viewer/data/metric-query.js';
import { defaultMetricState } from '../../src/viewer/state/metric-state.js';

function query(over: Partial<MetricQuery>): MetricQuery {
  return {
    id: 'a',
    metric: 'http.server.duration',
    kind: null,
    unit: null,
    show: 'p95',
    by: [],
    where: null,
    fn: [],
    alias: null,
    hidden: false,
    ...over,
  };
}

function entry(type: MetricEntry['type'], monotonic: boolean): MetricEntry {
  return { name: 'm', unit: '', type, temporality: 'delta', monotonic, conflicting: false } as MetricEntry;
}

describe('defaultMetricState', () => {
  test('null gives one pending query', () => {
    const s = defaultMetricState(null);
    expect(s.queries).toEqual([query({ metric: '', show: '' })]);
  });

  test('uses the default show of the metric kind, keeps the summary placeholder', () => {
    expect(defaultMetricState(entry('sum', true)).queries[0]?.show).toBe('rate');
    expect(defaultMetricState(entry('sum', false)).queries[0]?.show).toBe('avg');
    expect(defaultMetricState(entry('histogram', false)).queries[0]?.show).toBe('p95');
    expect(defaultMetricState(entry('summary', false)).queries[0]?.show).toBe('qmax');
    expect(defaultMetricState(entry('gauge', false)).queries[0]).toMatchObject({ metric: 'm', kind: null });
  });
});
