import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DurationSummary, RedBuckets } from '../../src/viewer/data/results.js';
import { RedStrip, redSummary } from '../../src/viewer/traces/red-strip.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

function red(): RedBuckets {
  return {
    startNs: 0,
    widthNs: 1_000_000,
    counts: Array.from({ length: 10 }, () => 1),
    errors: Array.from({ length: 10 }, (_, i) => (i === 3 ? 1 : 0)),
    p50: Array.from({ length: 10 }, (_, i) => (i + 1) * 1000),
    p95: Array.from({ length: 10 }, (_, i) => (i + 1) * 1000),
    p99: Array.from({ length: 10 }, (_, i) => (i + 1) * 1000),
    max: Array.from({ length: 10 }, (_, i) => (i + 1) * 1000),
  };
}

const SUMMARY: DurationSummary = {
  count: 10,
  min: 1000,
  max: 10_000,
  sum: 55_000,
  p50: 5000,
  p95: 9500,
  p99: 9900,
};

describe('RedStrip', () => {
  test('totals come from the buckets, the percentiles from the exact duration summary', () => {
    const s = redSummary(red(), SUMMARY);
    expect(s.requests).toBe(10);
    expect(s.errors).toBe(1);
    expect(s.errorRate).toBeCloseTo(0.1);
    expect(s).toMatchObject({ p50: 5000, p95: 9500, p99: 9900, max: 10_000 });
  });

  test('no spans summarise to zeros', () => {
    expect(
      redSummary(
        {
          ...red(),
          counts: [0, 0],
          errors: [0, 0],
          p50: [null, null],
          p95: [null, null],
          p99: [null, null],
          max: [null, null],
        },
        null,
      ),
    ).toEqual({ requests: 0, errors: 0, errorRate: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  });

  test('Analyze buttons report the matching measure; the strip collapses', async () => {
    const user = userEvent.setup();
    const onAnalyze = vi.fn();
    render(<RedStrip red={red()} durations={SUMMARY} onAnalyze={onAnalyze} />);
    await user.click(screen.getByRole('button', { name: 'Analyze errors' }));
    expect(onAnalyze).toHaveBeenLastCalledWith('errors');
    await user.click(screen.getByRole('button', { name: 'Analyze latency' }));
    expect(onAnalyze).toHaveBeenLastCalledWith('latency');
    await user.click(screen.getByRole('button', { name: /Requests, errors and latency/ }));
    expect(screen.queryByRole('button', { name: 'Analyze errors' })).toBeNull();
  });
});
