import { describe, expect, test } from 'vitest';
import type { MetricEntry } from '../../src/rollups/metric-catalog.js';
import type { MetricQuery } from '../../src/viewer/data/metric-query.js';
import { defaultMetricState, MetricPageStateSchema } from '../../src/viewer/state/metric-state.js';

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

describe('MetricPageStateSchema', () => {
  const base = { queries: [query({})] };

  test('fills the optional fields and page settings', () => {
    const r = MetricPageStateSchema.parse({ queries: [{ id: 'a', metric: 'x', show: 'avg' }] });
    expect(r).toEqual({
      queries: [query({ metric: 'x', show: 'avg' })],
      formulas: [],
      display: 'lines',
      scale: 'linear',
      split: false,
      exemplars: false,
    });
  });

  test('rejects duplicate query ids, bad ids, more than 10 queries and bad formula ids', () => {
    const q = (id: string): MetricQuery => query({ id });
    expect(MetricPageStateSchema.safeParse({ queries: [q('a'), q('a')] }).success).toBe(false);
    expect(MetricPageStateSchema.safeParse({ queries: [q('A')] }).success).toBe(false);
    const eleven = 'abcdefghijk'.split('').map(q);
    expect(MetricPageStateSchema.safeParse({ queries: eleven }).success).toBe(false);
    const ten = 'abcdefghij'.split('').map(q);
    expect(MetricPageStateSchema.safeParse({ queries: ten }).success).toBe(true);
    const f = (id: string) => ({ id, expr: 'a', alias: null, hidden: false });
    expect(MetricPageStateSchema.safeParse({ ...base, formulas: [f('f1'), f('f2')] }).success).toBe(true);
    expect(MetricPageStateSchema.safeParse({ ...base, formulas: [f('x')] }).success).toBe(false);
    expect(MetricPageStateSchema.safeParse({ ...base, formulas: [f('f1'), f('f1')] }).success).toBe(false);
  });

  test('where must compile in the datapoint context', () => {
    const ok = query({ where: 'attributes["http.route"] == "/pay"' });
    expect(MetricPageStateSchema.safeParse({ queries: [ok] }).success).toBe(true);
    const bad = query({ where: 'span.name == "x"' });
    const r = MetricPageStateSchema.safeParse({ queries: [bad] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['queries', 0, 'where']);
  });

  test('heatmap without a histogram query is allowed', () => {
    expect(MetricPageStateSchema.safeParse({ ...base, display: 'heatmap' }).success).toBe(true);
  });
});

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
