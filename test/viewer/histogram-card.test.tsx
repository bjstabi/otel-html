import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import type { SpanStatusKey } from '../../src/rollups/span-rollups.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';

vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string; option: unknown }): React.JSX.Element => (
    <div role="img" aria-label={p.ariaLabel} data-option={JSON.stringify(p.option)} />
  ),
}));

import { brushToWindow, HistogramCard } from '../../src/viewer/components/histogram-card.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

function buckets(): TimeBuckets<SpanStatusKey> {
  const b = new TimeBuckets<SpanStatusKey>(['ok', 'error', 'unset']);
  const at = (n: number): RelNanos => (n * b.widthNs) as RelNanos;
  b.add(at(0), 'ok', 5);
  b.add(at(1), 'ok', 2);
  b.add(at(1), 'error', 3);
  b.add(at(2), 'ok', 1);
  return b;
}

describe('brushToWindow', () => {
  test('maps an inclusive bucket range to a half-open time window in either order', () => {
    const b = buckets();
    const w = b.widthNs;
    expect(brushToWindow(b, 1, 2)).toEqual({ start: w, end: 3 * w });
    expect(brushToWindow(b, 2, 1)).toEqual({ start: w, end: 3 * w });
  });

  test('clamps the end of the last bucket to the run end', () => {
    const b = buckets();
    expect(brushToWindow(b, 2, 2, 2 * b.widthNs + 5)).toEqual({
      start: 2 * b.widthNs,
      end: 2 * b.widthNs + 5,
    });
  });
});

describe('HistogramCard', () => {
  test('stacks status series, error with a critical colour and a hatch decal, with labelled totals', () => {
    render(
      <SelectionProvider store={createSelectionStore({})}>
        <HistogramCard buckets={buckets()} />
      </SelectionProvider>,
    );
    const img = screen.getByRole('img');
    const opt = JSON.parse(img.getAttribute('data-option') ?? '{}') as {
      series: { name: string; stack: string; itemStyle: { color: string; decal?: unknown } }[];
    };
    expect(opt.series.map((s) => s.name)).toEqual(['ok', 'error', 'unset']);
    expect(new Set(opt.series.map((s) => s.stack)).size).toBe(1);
    expect(opt.series[1]?.itemStyle.decal).toBeTruthy();
    expect(opt.series[0]?.itemStyle.decal).toBeUndefined();
    expect(screen.getByText('3 errors')).toBeTruthy();
    expect(img.getAttribute('aria-label')).toMatch(/11 spans/);
  });

  test('keyboard brush: arrows move, shift extends, Enter applies setWindow, Escape clears', async () => {
    const user = userEvent.setup();
    const store = createSelectionStore({});
    const b = buckets();
    render(
      <SelectionProvider store={store}>
        <HistogramCard buckets={b} />
      </SelectionProvider>,
    );
    const brush = screen.getByRole('group', { name: 'Time brush' });
    brush.focus();
    await user.keyboard('{ArrowRight}{Shift>}{ArrowRight}{/Shift}{Enter}');
    expect(store.getState().window).toEqual({ start: b.widthNs, end: 3 * b.widthNs });
    await user.keyboard('{Escape}');
    expect(store.getState().window).toBeNull();
  });
});
