import { describe, expect, test } from 'vitest';
import type { LogNeed, LogQuery, LogQueryResult } from '../../src/viewer/data/results.js';

describe('format-4 log query shapes', () => {
  test('a query names what to compute and a result says whether residual terms ran', () => {
    const needs: readonly LogNeed[] = ['rows', 'facets', 'timeline'];
    const q: LogQuery = {
      condition: null,
      text: '',
      window: null,
      mode: 'logs',
      sort: { column: 'time', dir: 'desc' },
      limit: 100,
      needs,
      facetKeys: null,
    };
    const r: LogQueryResult = {
      mode: 'logs',
      rows: [],
      total: 0,
      matched: 0,
      facets: {} as unknown as LogQueryResult['facets'],
      buckets: { startNs: 0, widthNs: 1, series: {} } as unknown as LogQueryResult['buckets'],
      residual: false,
    };
    expect(q.needs).toHaveLength(3);
    expect(r.residual).toBe(false);
  });
});
