import { describe, expect, it } from 'vitest';
import { MetricPageStateSchema } from '../../src/query/metric-query.js';
import { PAGE_OPTIONS } from '../../src/query/pages.js';

describe('shared query module', () => {
  it('exposes the metric page-state schema and the page options', () => {
    expect(MetricPageStateSchema.safeParse({ queries: [] }).success).toBe(true);
    expect(PAGE_OPTIONS.logs.context).toBe('log_record');
  });
});
