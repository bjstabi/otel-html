import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';

vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string; option: unknown }): React.JSX.Element => (
    <div role="img" aria-label={p.ariaLabel} data-option={JSON.stringify(p.option)} />
  ),
}));

import { DashboardSchema } from '../../src/dashboards/schema.js';
import { FusionTimeline, type TimelineLane } from '../../src/viewer/components/fusion-timeline.js';
import { SEVERITY_SERIES, SPAN_STATUS_SERIES } from '../../src/viewer/components/histogram-card.js';
import type { WidgetActions } from '../../src/viewer/dashboards/dashboard-page.js';
import { TimelineWidget } from '../../src/viewer/dashboards/widgets/timeline.js';
import { createDataSource } from '../../src/viewer/data/data-source.js';
import type { TimeWindow } from '../../src/viewer/data/span-query.js';
import { buildEmbeddedMetricsReport } from './report-fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const MS = 1_000_000;

function lanes(): TimelineLane[] {
  const spans = new TimeBuckets<'ok' | 'error' | 'unset'>(['ok', 'error', 'unset']);
  for (let i = 0; i < 10; i++) spans.add((i * MS) as RelNanos, i === 3 ? 'error' : 'ok');
  const points = new TimeBuckets<'points'>(['points']);
  points.add(0 as RelNanos, 'points', 2);
  return [
    { label: 'Spans', total: 10, buckets: spans, series: SPAN_STATUS_SERIES, note: null },
    {
      label: 'Logs',
      total: 0,
      buckets: new TimeBuckets(['info'], 8),
      series: SEVERITY_SERIES,
      note: 'no logs',
    },
    {
      label: 'Metric points',
      total: 2,
      buckets: points,
      series: {
        noun: 'points',
        topFirst: false,
        series: [{ key: 'points', label: 'points', color: '#000' }],
      },
      note: null,
    },
  ];
}

const WINDOW: TimeWindow = { start: 0, end: 10 * MS };

/** jsdom has no layout: the brush overlay is 1000 px wide at x = 0. */
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 1000,
    bottom: 100,
    width: 1000,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

function show(onBrush = vi.fn(), brush: TimeWindow | null = null) {
  render(<FusionTimeline lanes={lanes()} window={WINDOW} brush={brush} height={150} onBrush={onBrush} />);
  return onBrush;
}

describe('FusionTimeline', () => {
  test('draws a lane per signal with its total and note', () => {
    show();
    expect(screen.getByText('Spans 10')).toBeTruthy();
    expect(screen.getByText('Logs 0')).toBeTruthy();
    expect(screen.getByText(/no logs/)).toBeTruthy();
    expect(screen.getByText('Metric points 2')).toBeTruthy();
    const option = JSON.parse(screen.getByRole('img').getAttribute('data-option') ?? '{}');
    expect(option.grid).toHaveLength(3);
    expect(option.xAxis).toHaveLength(3);
  });

  test('the error series keeps its hatch', () => {
    show();
    const option = JSON.parse(screen.getByRole('img').getAttribute('data-option') ?? '{}');
    const error = option.series.find((s: { name: string }) => s.name === 'error');
    expect(error.itemStyle.decal.symbol).toBe('rect');
  });

  test('dragging across the plot brushes whole-nanosecond bounds inside the window', () => {
    const onBrush = show();
    const brush = screen.getByRole('group', { name: 'Time brush' });
    fireEvent.pointerDown(brush, { clientX: 250, pointerId: 1 });
    fireEvent.pointerMove(brush, { clientX: 700, pointerId: 1 });
    fireEvent.pointerUp(brush, { clientX: 700, pointerId: 1 });
    expect(onBrush).toHaveBeenCalledTimes(1);
    const w = onBrush.mock.calls[0]?.[0] as TimeWindow;
    expect(Number.isInteger(w.start) && Number.isInteger(w.end)).toBe(true);
    expect(w.start).toBeGreaterThanOrEqual(WINDOW.start);
    expect(w.end).toBeLessThanOrEqual(WINDOW.end);
    expect(w.end).toBeGreaterThan(w.start);
  });

  test('dragging backwards gives the same window; a click clears the brush', () => {
    const onBrush = show();
    const brush = screen.getByRole('group', { name: 'Time brush' });
    fireEvent.pointerDown(brush, { clientX: 700, pointerId: 1 });
    fireEvent.pointerUp(brush, { clientX: 250, pointerId: 1 });
    fireEvent.pointerDown(brush, { clientX: 250, pointerId: 1 });
    fireEvent.pointerUp(brush, { clientX: 700, pointerId: 1 });
    const [a, b] = onBrush.mock.calls.map((c) => c[0]);
    expect(a).toEqual(b);
    fireEvent.pointerDown(brush, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(brush, { clientX: 401, pointerId: 1 });
    expect(onBrush).toHaveBeenLastCalledWith(null);
  });

  test('the page brush is drawn over the plot', () => {
    show(vi.fn(), { start: 2 * MS, end: 5 * MS });
    const band = screen.getByRole('group', { name: 'Time brush' }).firstElementChild as HTMLElement;
    expect(band.style.left).toBe('20%');
    expect(band.style.width).toBe('30%');
  });
});

describe('TimelineWidget on the linked fixture', () => {
  async function widget(variables: { key: string; value: string; kind: 'string' }[]) {
    const linked = await buildEmbeddedMetricsReport();
    const ds = await createDataSource(createScriptedLoader(linked.files), linked.manifest, 1);
    const dashboard = DashboardSchema.parse({
      id: 'd',
      title: 'D',
      widgets: [{ type: 'timeline', x: 0, y: 0, w: 12, h: 6 }],
    });
    const w = dashboard.widgets[0];
    if (w === undefined) throw new Error('no widget');
    const actions: WidgetActions = {
      selectWindow: vi.fn(),
      selectTrace: vi.fn(),
      openIn: vi.fn(),
      setLogView: vi.fn(),
    };
    render(
      <TimelineWidget
        widget={w}
        scope={{
          window: null,
          band: null,
          traceFilter: null,
          highlightTrace: null,
          condition: null,
          outside: false,
        }}
        dashboard={{ dashboard, source: 'x', isDefault: false }}
        height={200}
        dataSource={ds}
        actions={actions}
        variables={variables}
      />,
    );
    await act(async () => {});
    return actions;
  }

  test('three lanes with their totals', async () => {
    await widget([]);
    await waitFor(() => expect(screen.getByText('Spans 2')).toBeTruthy());
    expect(screen.getByText('Logs 2')).toBeTruthy();
    expect(screen.getByText('Metric points 100')).toBeTruthy();
    expect(screen.queryByText(/all resources/)).toBeNull();
  });

  test('with a bound variable the metric lane says all resources', async () => {
    await widget([{ key: 'service.name', value: 'checkout', kind: 'string' }]);
    await waitFor(() => expect(screen.getByText(/all resources/)).toBeTruthy());
  });
});
