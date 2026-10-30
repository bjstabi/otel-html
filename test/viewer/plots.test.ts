import { describe, expect, test } from 'vitest';
import type { MetricPageState } from '../../src/query/metric-query.js';
import type { MetricQuery, MetricQueryResult } from '../../src/viewer/data/metric-query.js';
import { buildPlots } from '../../src/viewer/metrics/plots.js';
import { defaultMetricState } from '../../src/viewer/state/metric-state.js';

const result = (queryId: string, label: string): MetricQueryResult => ({
  queryId,
  widthNs: 1,
  series: [{ key: 'k', label, group: {}, unit: '1', points: [[0, 1]], resourceService: null }],
  exemplars: [],
  heat: null,
  distribution: null,
  notes: [],
});

function stateWith(over: Partial<MetricQuery>): MetricPageState {
  const base = defaultMetricState(null);
  return {
    ...base,
    queries: base.queries.map((q) => ({ ...q, metric: 'cpu', show: 'avg', ...over })),
  };
}

describe('buildPlots', () => {
  test('labels a result with the query it ran for, not the state as it is now, except the alias', () => {
    const ran = stateWith({});
    const now = stateWith({ show: 'max', alias: 'load' });
    const results = new Map([['a', result('a', 'cpu')]]);
    const run = { results, entries: new Map(), ran: { queries: ran.queries, formulas: [] } };
    // While `max` loads, the `avg` result keeps its show in the title and series label; the alias applies at once.
    const [plot] = buildPlots(now, run);
    expect(plot?.title).toBe('load');
    expect(plot?.result.series[0]?.label).toBe('load');
    const [unaliased] = buildPlots(stateWith({ show: 'max' }), run);
    expect(unaliased?.title).toBe('cpu · avg');
    expect(unaliased?.result.series[0]?.label).toBe('a · avg');
    // Without `ran` (a caller that has no run yet) the state labels the result.
    const [plain] = buildPlots(stateWith({ show: 'max' }), { results, entries: new Map() });
    expect(plain?.title).toBe('cpu · max');
  });

  test('a hidden query draws nothing, whatever ran', () => {
    const now = stateWith({ hidden: true });
    const run = {
      results: new Map([['a', result('a', 'cpu')]]),
      entries: new Map(),
      ran: { queries: stateWith({}).queries, formulas: [] },
    };
    expect(buildPlots(now, run)).toEqual([]);
  });
});
