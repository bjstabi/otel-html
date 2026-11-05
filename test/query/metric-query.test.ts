import { describe, expect, test } from 'vitest';
import { MetricPageStateSchema, type MetricQuery, MetricQuerySchema } from '../../src/query/metric-query.js';

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

  test.each([
    ['time_unix_nano > 0', 'time filters use the time range'],
    ['datapoint.start_time_unix_nano > 0', 'time filters use the time range'],
    ['flags == 1', 'flags is a per-point field; metric filters select whole series'],
  ])('where %s fails validation with the per-point message (#177)', (where, why) => {
    const r = MetricQuerySchema.safeParse({ id: 'a', metric: 'm', show: 'x', where });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['where']);
    expect(r.error?.issues[0]?.message).toBe(`a condition on whole series (col 1: ${why})`);
    const page = MetricPageStateSchema.safeParse({ queries: [query({ where })] });
    expect(page.error?.issues[0]?.path).toEqual(['queries', 0, 'where']);
  });

  test('heatmap without a histogram query is allowed', () => {
    expect(MetricPageStateSchema.safeParse({ ...base, display: 'heatmap' }).success).toBe(true);
  });
});
