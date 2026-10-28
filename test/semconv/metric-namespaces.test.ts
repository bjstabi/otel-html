import { describe, expect, it } from 'vitest';
import { compareNamespaces, metricNamespace, NAMESPACE_ORDER } from '../../src/semconv/metric-namespaces.js';

describe('metricNamespace', () => {
  it('takes the prefix before the first dot, else other', () => {
    expect(metricNamespace('http.server.request.duration')).toBe('http');
    expect(metricNamespace('jobs')).toBe('other');
    expect(metricNamespace('.x')).toBe('other');
    expect(metricNamespace('')).toBe('other');
  });
  it('sorts by NAMESPACE_ORDER, then alphabetically, with other last', () => {
    expect(NAMESPACE_ORDER[0]).toBe('process');
    const sorted = ['other', 'zeta', 'gen_ai', 'alpha', 'http', 'process'].sort(compareNamespaces);
    expect(sorted).toEqual(['process', 'http', 'gen_ai', 'alpha', 'zeta', 'other']);
  });
});
