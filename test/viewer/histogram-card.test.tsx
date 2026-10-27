import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import type { SpanStatusKey } from '../../src/rollups/span-rollups.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { LOG_SEVERITY_KEYS, type LogSeverityKey } from '../../src/semconv/severity.js';

vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string; option: unknown }): React.JSX.Element => (
    <div role="img" aria-label={p.ariaLabel} data-option={JSON.stringify(p.option)} />
  ),
}));

import {
  brushToWindow,
  coarsenBuckets,
  HISTOGRAM_MAX_COLUMNS,
  HistogramCard,
  SEVERITY_SERIES,
  SPAN_STATUS_SERIES,
} from '../../src/viewer/components/histogram-card.js';
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

/** One ok span per bucket, an error in every 7th: `n` buckets wide. */
function wide(n: number): TimeBuckets<SpanStatusKey> {
  const b = new TimeBuckets<SpanStatusKey>(['ok', 'error', 'unset']);
  const w = b.widthNs;
  for (let i = 0; i < n; i++) {
    b.add((i * w) as RelNanos, 'ok');
    if (i % 7 === 0) b.add((i * w) as RelNanos, 'error');
  }
  return b;
}

describe('coarsenBuckets', () => {
  test('leaves a histogram that already fits untouched', () => {
    const b = buckets();
    expect(coarsenBuckets(b)).toBe(b);
  });

  test('sums neighbouring buckets into at most the column cap, keeping totals and the time extent', () => {
    const b = wide(2500);
    const v = coarsenBuckets(b);
    const f = Math.ceil(2500 / HISTOGRAM_MAX_COLUMNS);
    expect(v.length).toBeLessThanOrEqual(HISTOGRAM_MAX_COLUMNS);
    expect(v.length).toBe(Math.ceil(2500 / f));
    expect(v.widthNs).toBe(b.widthNs * f);
    expect(v.startNs).toBe(b.startNs);
    for (const k of b.keys) {
      expect(v.counts(k).reduce((a, x) => a + x, 0)).toBe(b.total(k));
      expect(v.total(k)).toBe(b.total(k));
    }
    expect(v.counts('ok')[0]).toBe(f);
    expect(v.counts('ok').at(-1)).toBe(2500 - (v.length - 1) * f);
  });

  test('a brush over coarse columns selects the whole time of the buckets they merged', () => {
    const b = wide(2500);
    const v = coarsenBuckets(b);
    expect(brushToWindow(v, 1, 2)).toEqual({ start: b.startNs + v.widthNs, end: b.startNs + 3 * v.widthNs });
  });
});

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
        <HistogramCard buckets={buckets()} series={SPAN_STATUS_SERIES} />
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

  test('draws a wide histogram at most HISTOGRAM_MAX_COLUMNS columns wide', () => {
    render(
      <SelectionProvider store={createSelectionStore({})}>
        <HistogramCard buckets={wide(2500)} series={SPAN_STATUS_SERIES} />
      </SelectionProvider>,
    );
    const img = screen.getByRole('img');
    const opt = JSON.parse(img.getAttribute('data-option') ?? '{}') as {
      xAxis: { data: string[] };
      series: { data: number[] }[];
    };
    expect(opt.xAxis.data.length).toBeLessThanOrEqual(HISTOGRAM_MAX_COLUMNS);
    for (const s of opt.series) expect(s.data.length).toBe(opt.xAxis.data.length);
    expect(img.getAttribute('aria-label')).toMatch(/2858 spans/);
  });

  test('keyboard brush: arrows move, shift extends, Enter applies setWindow, Escape clears', async () => {
    const user = userEvent.setup();
    const store = createSelectionStore({});
    const b = buckets();
    render(
      <SelectionProvider store={store}>
        <HistogramCard buckets={b} series={SPAN_STATUS_SERIES} />
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

describe('HistogramCard with log severities', () => {
  test('one legend entry per severity, labelled, fatal on top of the stack, with a custom title', () => {
    const b = new TimeBuckets<LogSeverityKey>(LOG_SEVERITY_KEYS);
    b.add(0 as RelNanos, 'error', 2);
    b.add(0 as RelNanos, 'info', 5);
    render(
      <SelectionProvider store={createSelectionStore({})}>
        <HistogramCard buckets={b} series={SEVERITY_SERIES} title="Logs over time" />
      </SelectionProvider>,
    );
    const img = screen.getByRole('img');
    const opt = JSON.parse(img.getAttribute('data-option') ?? '{}') as {
      legend: { data: string[] };
      series: { name: string; itemStyle: { color: string } }[];
    };
    expect(opt.legend.data).toEqual(['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'UNSPECIFIED']);
    // ECharts stacks the first series at the bottom, so fatal is emitted last.
    expect(opt.series.map((s) => s.name)).toEqual([...opt.legend.data].reverse());
    expect(screen.getByRole('region', { name: 'Logs over time' })).toBeTruthy();
    expect(screen.getByText('7 logs')).toBeTruthy();
    expect(img.getAttribute('aria-label')).toMatch(/Logs over time: 7 logs/);
  });

  test('severity tokens are css variables', () => {
    for (const s of SEVERITY_SERIES.series) expect(s.color).toBe(`var(--oh-sev-${s.key})`);
  });

  test('the noun and error total come from the series set, not the title', () => {
    const b = new TimeBuckets<LogSeverityKey>(LOG_SEVERITY_KEYS);
    b.add(0 as RelNanos, 'fatal', 1);
    b.add(0 as RelNanos, 'error', 2);
    b.add(0 as RelNanos, 'info', 37);
    render(
      <SelectionProvider store={createSelectionStore({})}>
        <HistogramCard buckets={b} series={SEVERITY_SERIES} title="40 logs by severity" />
      </SelectionProvider>,
    );
    expect(screen.getByText('40 logs')).toBeTruthy();
    expect(screen.getByText('3 errors')).toBeTruthy();
    const opt = JSON.parse(screen.getByRole('img').getAttribute('data-option') ?? '{}') as {
      series: { name: string; itemStyle: { decal?: unknown } }[];
    };
    const hatched = opt.series.filter((x) => x.itemStyle.decal !== undefined).map((x) => x.name);
    expect(hatched.sort()).toEqual(['ERROR', 'FATAL']);
    const legend = screen.getByRole('list', { name: 'Severity counts' });
    expect([...legend.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'FATAL 1',
      'ERROR 2',
      'INFO 37',
    ]);
  });

  test('span status sets carry no count legend', () => {
    render(
      <SelectionProvider store={createSelectionStore({})}>
        <HistogramCard buckets={new TimeBuckets(['ok', 'error', 'unset'])} series={SPAN_STATUS_SERIES} />
      </SelectionProvider>,
    );
    expect(screen.queryByRole('list')).toBeNull();
  });
});
