import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';

vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string; option: unknown }): React.JSX.Element => (
    <div role="img" aria-label={p.ariaLabel} data-option={JSON.stringify(p.option)} />
  ),
}));

import { DashboardSchema } from '../../src/dashboards/schema.js';
import {
  alignLanes,
  FusionTimeline,
  type TimelineLane,
} from '../../src/viewer/components/fusion-timeline.js';
import {
  brushToWindow,
  SEVERITY_SERIES,
  SPAN_STATUS_SERIES,
} from '../../src/viewer/components/histogram-card.js';
import type { WidgetActions } from '../../src/viewer/dashboards/dashboard-page.js';
import { TimelineWidget } from '../../src/viewer/dashboards/widgets/timeline.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { manifestRange } from '../../src/viewer/data/manifest-range.js';
import type { LogQuery, SpanQuery, SpanQueryResult } from '../../src/viewer/data/results.js';
import type { TimeWindow } from '../../src/viewer/data/time-window.js';
import { EMPTY_DASHBOARD_STATE } from '../../src/viewer/state/dashboard-state.js';
import { baseManifest, dataSourceOf, emptyLogResult, emptySpanResult } from './dashboard-shell.js';
import { fusionSource } from './fusion-source.js';

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

  test('dragging across the plot brushes the exact columns under the pointer', () => {
    const onBrush = show();
    const brush = screen.getByRole('group', { name: 'Time brush' });
    fireEvent.pointerDown(brush, { clientX: 250, pointerId: 1 });
    fireEvent.pointerMove(brush, { clientX: 700, pointerId: 1 });
    fireEvent.pointerUp(brush, { clientX: 700, pointerId: 1 });
    // 1000 px over eleven columns: px 250 is column 2, px 700 is column 7 (inclusive).
    expect(onBrush).toHaveBeenCalledOnce();
    expect(onBrush).toHaveBeenCalledWith({ start: 2 * MS, end: 8 * MS });
  });

  test('a window that is not whole milliseconds clamps the brush to its own bounds', () => {
    const onBrush = vi.fn();
    const window: TimeWindow = { start: 1_500_500, end: 9_500_500 };
    render(<FusionTimeline lanes={lanes()} window={window} brush={null} height={150} onBrush={onBrush} />);
    const brush = screen.getByRole('group', { name: 'Time brush' });
    // Columns start at 1 ms: nine of them, so the full width is columns 0-8.
    fireEvent.pointerDown(brush, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(brush, { clientX: 999, pointerId: 1 });
    expect(onBrush).toHaveBeenLastCalledWith({ start: 1_500_500, end: 9_500_500 });
    // Columns 2-3 are 3 ms to 5 ms, inside the window, so they pass through whole.
    fireEvent.pointerDown(brush, { clientX: 230, pointerId: 1 });
    fireEvent.pointerUp(brush, { clientX: 390, pointerId: 1 });
    expect(onBrush).toHaveBeenLastCalledWith({ start: 3 * MS, end: 5 * MS });
  });

  test('a cancelled pointer drops the pending press and the band', () => {
    const onBrush = show();
    const brush = screen.getByRole('group', { name: 'Time brush' });
    fireEvent.pointerDown(brush, { clientX: 250, pointerId: 1 });
    expect(brush.firstElementChild).not.toBeNull();
    fireEvent.pointerCancel(brush, { pointerId: 1 });
    expect(brush.firstElementChild).toBeNull();
    fireEvent.pointerUp(brush, { clientX: 700, pointerId: 1 });
    expect(onBrush).not.toHaveBeenCalled();
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

  test('after Enter commits, the arrows go on from the committed column', () => {
    const onBrush = show();
    const brush = screen.getByRole('group', { name: 'Time brush' });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(brush, { key: 'ArrowRight' });
    fireEvent.keyDown(brush, { key: 'Enter' });
    expect(onBrush).toHaveBeenLastCalledWith({ start: 3 * MS, end: 4 * MS });
    fireEvent.keyDown(brush, { key: 'ArrowRight' });
    fireEvent.keyDown(brush, { key: 'Enter' });
    expect(onBrush).toHaveBeenLastCalledWith({ start: 4 * MS, end: 5 * MS });
  });

  test('an approximate total is shown as ~N', () => {
    const ls = lanes().map((l) => (l.label === 'Metric points' ? { ...l, approximate: true } : l));
    render(<FusionTimeline lanes={ls} window={WINDOW} brush={null} height={150} onBrush={vi.fn()} />);
    expect(screen.getByText('Metric points ~2')).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Metric points ~2');
  });

  test('the page brush is drawn over the plot', () => {
    show(vi.fn(), { start: 2 * MS, end: 5 * MS });
    const band = screen.getByRole('group', { name: 'Time brush' }).firstElementChild as HTMLElement;
    // The window ends on a bucket edge, so the bucket at 10 ms is a column too: eleven columns, not ten.
    expect(Number.parseFloat(band.style.left)).toBeCloseTo((2 / 11) * 100, 6);
    expect(Number.parseFloat(band.style.width)).toBeCloseTo((3 / 11) * 100, 6);
  });
  test('a zero-width page brush at the aligned window end is drawn as the last column', () => {
    show(vi.fn(), { start: 10 * MS, end: 10 * MS });
    const band = screen.getByRole('group', { name: 'Time brush' }).firstElementChild as HTMLElement;
    expect(Number.parseFloat(band.style.left)).toBeCloseTo((10 / 11) * 100, 6);
    expect(Number.parseFloat(band.style.width)).toBeCloseTo((1 / 11) * 100, 6);
  });
});

describe('alignLanes at an aligned window end', () => {
  const window: TimeWindow = { start: 0, end: 8 * MS };

  test('alignLanes gives the bucket that starts at an aligned window end a column', () => {
    const buckets = new TimeBuckets<'points'>(['points']);
    buckets.add((8 * MS) as RelNanos, 'points');
    const aligned = alignLanes([{ buckets }], window);
    expect(buckets.widthNs).toBe(MS);
    expect(aligned.length).toBe(9);
    expect(aligned.lanes[0]?.total('points')).toBe(1);
    expect(aligned.lanes[0]?.counts('points')[8]).toBe(1);
  });

  test('a spans and a logs bucket at the aligned end are drawn too', () => {
    const spans = new TimeBuckets<'ok' | 'error' | 'unset'>(['ok', 'error', 'unset']);
    spans.add((8 * MS) as RelNanos, 'ok');
    const logs = new TimeBuckets<'info'>(['info']);
    logs.add((8 * MS) as RelNanos, 'info', 3);
    const aligned = alignLanes([{ buckets: spans }, { buckets: logs }], window);
    expect(aligned.lanes[0]?.counts('ok')[8]).toBe(1);
    expect(aligned.lanes[1]?.counts('info')[8]).toBe(3);
    expect(aligned.lanes[1]?.total('info')).toBe(3);
  });

  test('a window that is not aligned keeps the column count', () => {
    const buckets = new TimeBuckets<'points'>(['points']);
    buckets.add(0 as RelNanos, 'points');
    expect(alignLanes([{ buckets }], { start: 0, end: 8 * MS + 1 }).length).toBe(9);
    expect(alignLanes([{ buckets }], { start: 0, end: 7 * MS + 500 }).length).toBe(8);
  });

  test('a metric point at the window end is drawn in the column of the rendered chart', () => {
    const points = new TimeBuckets<'points'>(['points']);
    points.add((8 * MS) as RelNanos, 'points', 2);
    const ls: TimelineLane[] = [
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
    render(<FusionTimeline lanes={ls} window={window} brush={null} height={150} onBrush={vi.fn()} />);
    const option = JSON.parse(screen.getByRole('img').getAttribute('data-option') ?? '{}');
    const data: unknown[] = option.series[0].data;
    expect(data).toHaveLength(9);
    expect(JSON.stringify(data[8])).toContain('2');
  });
});

describe('TimelineWidget on the linked fixture', () => {
  async function widget(
    variables: { key: string; value: string; kind: 'string' }[],
    window: TimeWindow | null = null,
  ) {
    const ds = fusionSource();
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
      setSubtitle: vi.fn(),
      setVariable: vi.fn(),
      setControls: vi.fn(),
    };
    render(
      <TimelineWidget
        widget={w}
        scope={{
          window,
          narrowed: false,
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
        controls={null}
        state={EMPTY_DASHBOARD_STATE}
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

  test('a window that cuts a bucket of metric points marks the total ~', async () => {
    const ds = fusionSource();
    const points = await ds.metricPoints();
    const i = points.counts('points').findIndex((c) => c > 0);
    const from = Math.max(points.startNs + i * points.widthNs, manifestRange(ds.manifest)?.start ?? 0);
    await widget([], { start: from + 1, end: from + 2 });
    expect(await screen.findByText(/^Metric points ~\d+$/)).toBeTruthy();
  });

  test('a metric point in the bucket at an aligned window end is counted', async () => {
    const ds = fusionSource();
    const points = await ds.metricPoints();
    const counts = points.counts('points');
    const range = manifestRange(ds.manifest);
    if (range === undefined || range === null) throw new Error('no range');
    // The fixture's range end falls inside its last bucket, so end the window where that bucket starts: the window
    // end is aligned, as it is whenever a report's range end sits on a bucket edge.
    const last = Math.floor((range.end - points.startNs) / points.widthNs);
    const end = points.startNs + last * points.widthNs;
    const atEnd = counts[last] ?? 0;
    const before = counts[last - 1] ?? 0;
    expect(atEnd).toBeGreaterThan(0);
    await widget([], { start: end - 1, end });
    expect(await screen.findByText(new RegExp(`^Metric points ~?${atEnd + before}$`))).toBeTruthy();
  });

  test('with a bound variable the metric lane says all resources', async () => {
    await widget([{ key: 'service.name', value: 'checkout', kind: 'string' }]);
    await waitFor(() => expect(screen.getByText(/all resources/)).toBeTruthy());
  });
});

describe('TimelineWidget states', () => {
  const dashboard = DashboardSchema.parse({
    id: 'd',
    title: 'D',
    widgets: [{ type: 'timeline', x: 0, y: 0, w: 12, h: 6 }],
  });
  const actions: WidgetActions = {
    selectWindow: vi.fn(),
    selectTrace: vi.fn(),
    openIn: vi.fn(),
    setLogView: vi.fn(),
    setSubtitle: vi.fn(),
    setVariable: vi.fn(),
    setControls: vi.fn(),
  };

  function mount(ds: DataSource): void {
    const w = dashboard.widgets[0];
    if (w === undefined) throw new Error('no widget');
    render(
      <TimelineWidget
        widget={w}
        scope={{
          window: null,
          narrowed: false,
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
        variables={[]}
        controls={null}
        state={EMPTY_DASHBOARD_STATE}
      />,
    );
  }

  test('asks each signal for the timeline only, with a signal and no progress function', async () => {
    const calls: { spans: unknown[][]; logs: unknown[][] } = { spans: [], logs: [] };
    mount({
      ...dataSourceOf(baseManifest),
      querySpans: (...args) => {
        calls.spans.push(args);
        return Promise.resolve(emptySpanResult());
      },
      queryLogs: (...args) => {
        calls.logs.push(args);
        return Promise.resolve({ ...emptyLogResult() });
      },
    });
    await screen.findByText('Metric points 0');
    expect((calls.spans[0] as [SpanQuery])[0].needs).toEqual(['buckets']);
    expect((calls.logs[0] as [LogQuery])[0].needs).toEqual(['timeline']);
    expect(calls.spans[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(calls.spans[0]).toHaveLength(2);
    expect(calls.logs[0]).toHaveLength(2);
  });

  test('draws no chunk note and no Scan entire run button', async () => {
    mount(dataSourceOf(baseManifest));
    await screen.findByText('Metric points 0');
    expect(screen.queryByText(/chunks/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Scan entire run' })).toBeNull();
  });

  test('a failing query shows the error', async () => {
    const base = dataSourceOf(baseManifest);
    mount({ ...base, querySpans: () => Promise.reject(new Error('chunk 3 is corrupt')) });
    expect((await screen.findByRole('alert')).textContent).toContain('chunk 3 is corrupt');
  });

  test('loading shows a status until the queries settle', async () => {
    const base = dataSourceOf(baseManifest);
    mount({ ...base, querySpans: () => new Promise<SpanQueryResult>(() => {}) });
    expect(screen.getByRole('status').textContent).toBe('Loading');
  });

  test('an empty lane still draws, saying there is nothing in it', async () => {
    mount(dataSourceOf(baseManifest));
    expect(await screen.findByText('Metric points 0')).toBeTruthy();
    expect(screen.getByText(/no metric points/)).toBeTruthy();
    expect(screen.getByText(/no spans/)).toBeTruthy();
    expect(screen.getByText(/no logs/)).toBeTruthy();
  });
});

describe('alignLanes under a long window (buckets on absolute grains)', () => {
  const GRAIN = 65_536_000_000;
  const WIDTH = 2 * GRAIN;
  const ORIGIN = 12_345_678_901;

  /** Span buckets on the grid of `ORIGIN`: the first starts one column before the window, as the router's widened window can. */
  const spans = (): TimeBuckets<'ok' | 'error' | 'unset'> =>
    TimeBuckets.from(
      {
        maxBuckets: 4096,
        widthNs: WIDTH,
        startNs: ORIGIN - WIDTH,
        originNs: ORIGIN,
        keys: ['ok', 'error', 'unset'],
        counts: [
          [5, 0, 3, 0, 2],
          [0, 1, 0, 0, 0],
          [0, 0, 0, 0, 0],
        ],
      },
      ['ok', 'error', 'unset'],
    );

  test('every span bucket is kept, in the column that starts at its own time', () => {
    const points = new TimeBuckets<'points'>(['points']);
    for (let i = 0; i < 7; i++) points.add((i * 90_000_000_000) as RelNanos, 'points', 2);
    const window: TimeWindow = { start: 0, end: 5 * WIDTH };
    const aligned = alignLanes([{ buckets: spans() }, { buckets: points }], window);
    expect(aligned.widthNs).toBe(WIDTH);
    expect(aligned.startNs).toBe(ORIGIN - WIDTH);
    const [lane, metric] = aligned.lanes;
    expect(lane?.counts('ok').slice(0, 5)).toEqual([5, 0, 3, 0, 2]);
    expect((lane?.total('ok') ?? 0) + (lane?.total('error') ?? 0)).toBe(11);
    expect(metric?.total('points')).toBe(points.total('points'));
  });

  test('a brush over columns covers the bars shown', () => {
    const window: TimeWindow = { start: 0, end: 5 * WIDTH };
    const aligned = alignLanes([{ buckets: spans() }], window);
    const view = aligned.lanes[0];
    if (view === undefined) throw new Error('no lane');
    const w = brushToWindow(view, 0, 2);
    expect(w).toEqual({ start: ORIGIN - WIDTH, end: ORIGIN + 2 * WIDTH });
    // the three columns hold the first three source buckets, whole
    expect(view.counts('ok').slice(0, 3)).toEqual([5, 0, 3]);
  });

  test('a metric lane wider than the spans keeps the grid on the spans origin, and no span bucket is dropped', () => {
    const points = new TimeBuckets<'points'>(['points']);
    points.add(0 as RelNanos, 'points', 4);
    points.add(1_000_000_000_000_000 as RelNanos, 'points', 1);
    expect(points.widthNs).toBe(2 * WIDTH);
    const window: TimeWindow = { start: 0, end: 5 * WIDTH };
    const aligned = alignLanes([{ buckets: points }, { buckets: spans() }], window);
    expect(aligned.widthNs).toBe(2 * WIDTH);
    expect((aligned.startNs - (ORIGIN - WIDTH)) % (2 * WIDTH)).toBe(0);
    const lane = aligned.lanes[1];
    expect((lane?.total('ok') ?? 0) + (lane?.total('error') ?? 0)).toBe(11);
  });
});
