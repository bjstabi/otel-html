import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import { ExpHistogram } from '../../src/rollups/exp-histogram.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { RedSeries } from '../../src/rollups/red.js';
import { RedStrip, redSummary } from '../../src/viewer/traces/red-strip.js';
import { serviceStats } from '../../src/viewer/traces/services-page.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

function red(): RedSeries {
  const r = new RedSeries(16);
  for (let i = 0; i < 10; i++) r.add((i * 1_000_000) as RelNanos, (i + 1) * 1000, i === 3);
  return r;
}

describe('RedStrip', () => {
  test('summarises requests, errors and latency over every bucket', () => {
    const s = redSummary(red());
    expect(s.requests).toBe(10);
    expect(s.errors).toBe(1);
    expect(s.errorRate).toBeCloseTo(0.1);
    expect(s.max).toBe(10_000);
    expect(s.p50).toBeGreaterThan(0);
    expect(s.p99).toBeGreaterThanOrEqual(s.p50);
  });

  test('an empty series summarises to zeros without reading an empty histogram', () => {
    expect(redSummary(new RedSeries(16))).toEqual({
      requests: 0,
      errors: 0,
      errorRate: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    });
  });

  test('Analyze buttons report the matching measure; the strip collapses', async () => {
    const user = userEvent.setup();
    const onAnalyze = vi.fn();
    render(<RedStrip red={red()} onAnalyze={onAnalyze} />);
    await user.click(screen.getByRole('button', { name: 'Analyze errors' }));
    expect(onAnalyze).toHaveBeenLastCalledWith('errors');
    await user.click(screen.getByRole('button', { name: 'Analyze latency' }));
    expect(onAnalyze).toHaveBeenLastCalledWith('latency');
    await user.click(screen.getByRole('button', { name: /Requests, errors and latency/ }));
    expect(screen.queryByRole('button', { name: 'Analyze errors' })).toBeNull();
  });
});

describe('serviceStats', () => {
  test('requests from the service facet, percentiles merged across resources, errors from the error query', () => {
    const facets = new FacetCounts(10, 10, ['service.name']);
    for (let i = 0; i < 3; i++) facets.add('service.name', 'web');
    facets.add('service.name', 'db');
    const a = new ExpHistogram();
    const b = new ExpHistogram();
    for (const v of [100, 200]) a.record(v);
    b.record(300);
    const rows = serviceStats(
      facets,
      new Map([
        ['web\u0000GET /', a],
        ['web\u0000POST /', b],
      ]),
      new Map([['web', 1]]),
    );
    expect(rows.map((r) => [r.service, r.requests, r.errors])).toEqual([
      ['web', 3, 1],
      ['db', 1, 0],
    ]);
    expect(rows[0]?.errorRate).toBeCloseTo(1 / 3);
    expect(rows[0]?.p99).toBeGreaterThan(200);
    expect(rows[1]?.p50).toBe(0);
  });
});
