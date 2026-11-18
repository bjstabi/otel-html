import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard, Widget } from '../../../src/dashboards/schema.js';
import { DashboardSchema } from '../../../src/dashboards/schema.js';
import { RunActionsProvider } from '../../../src/viewer/cicd/run-actions.js';
import { CicdProvider } from '../../../src/viewer/cicd/use-cicd.js';
import { CicdWidget } from '../../../src/viewer/cicd/widget.js';
import type { ChartProps } from '../../../src/viewer/components/chart.js';
import type { CicdRow } from '../../../src/viewer/data/cicd-query.js';
import type { DataSource } from '../../../src/viewer/data/data-source.js';
import { type DashboardPageState, EMPTY_DASHBOARD_STATE } from '../../../src/viewer/state/dashboard-state.js';
import { ThemeProvider } from '../../../src/viewer/theme/theme-provider.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout; the chart is replaced by a probe that keeps its props.
const charts: ChartProps[] = [];
vi.mock('../../../src/viewer/components/chart.js', () => ({
  Chart: (props: ChartProps): null => {
    charts.push(props);
    return null;
  },
}));

const SEC = 1_000_000_000;
const DAY = 86_400 * SEC;
const TRACE = (i: number): string => i.toString(16).padStart(32, 'a');

const dashboard = DashboardSchema.parse({
  id: 'ci',
  title: 'CI',
  variables: ['cicd.pipeline.trigger'],
  widgets: [{ type: 'cicd', view: 'stat', stat: 'success-rate', x: 0, y: 0, w: 2, h: 6 }],
}) as Dashboard;

const blank: CicdRow = {
  kind: 'run',
  traceId: '',
  spanId: null,
  start: 0,
  end: 0,
  name: null,
  result: 'success',
  pipeline: null,
  runId: null,
  attempt: 1,
  trigger: 'push',
  branch: 'main',
  revision: 'abc',
  title: null,
  task: null,
  taskId: null,
  labels: null,
  queuedNs: null,
  needs: null,
  condition: null,
  failedStep: null,
  tasksReplayed: null,
  tasksRun: null,
};

function row(i: number, start: number, over: Partial<CicdRow> = {}): CicdRow {
  return {
    ...blank,
    traceId: TRACE(i),
    runId: `r${i}`,
    start,
    end: start + 60 * SEC,
    title: `commit ${i}`,
    ...over,
  };
}

const tasks = (i: number, replayed: number): CicdRow => ({
  ...blank,
  kind: 'tasks',
  traceId: TRACE(i),
  result: null,
  trigger: null,
  branch: null,
  revision: null,
  tasksReplayed: replayed,
  tasksRun: 3,
});

const widget = (view: string, extra: Record<string, unknown> = {}): Widget =>
  DashboardSchema.parse({
    id: 'ci',
    title: 'CI',
    widgets: [{ id: 'w1', type: 'cicd', view, x: 0, y: 0, w: 4, h: 6, ...extra }],
  }).widgets[0] as Widget;

let root: Root;
let host: HTMLElement;
let state: DashboardPageState;
let selected: unknown[];

/** 12 runs spread over 7 days; the 12th is cancelled, the 2nd failed; alternate runs replayed a task. */
function sevenDays(): CicdRow[] {
  return Array.from({ length: 12 }, (_, i) => i).flatMap((i) => [
    row(i + 1, Math.round(((i + 0.5) * 7 * DAY) / 12) + 7 * DAY, {
      result: i === 1 ? 'failure' : i === 11 ? 'cancelled' : 'success',
    }),
    tasks(i + 1, i % 2),
  ]);
}

const change = (fn: (s: DashboardPageState) => DashboardPageState): void => {
  state = fn(state);
};
const sources = new WeakMap<CicdRow[], DataSource>();
const sourceOf = (rows: CicdRow[]): DataSource => {
  let ds = sources.get(rows);
  if (ds === undefined) {
    ds = {
      cicdRows: () => Promise.resolve(rows),
      manifest: { epochUnixNano: '1700000000000000000' },
    } as unknown as DataSource;
    sources.set(rows, ds);
  }
  return ds;
};

async function show(w: Widget, rows: CicdRow[], extent = { start: 0, end: 14 * DAY }): Promise<void> {
  const dataSource = sourceOf(rows);
  const subtitles: (string | null)[] = [];
  const actions = {
    selectWindow: (win: unknown) => selected.push(win),
    setSubtitle: (t: string | null) => subtitles.push(t),
  };
  await act(async () => {
    root.render(
      <ThemeProvider>
        <CicdProvider dataSource={dataSource} extent={extent}>
          <RunActionsProvider dashboard={dashboard} state={state} change={change} dataSource={dataSource}>
            <CicdWidget
              widget={w}
              scope={
                {
                  window: { start: 7 * DAY, end: 14 * DAY },
                  vars: [],
                } as never
              }
              dashboard={{} as never}
              height={300}
              dataSource={dataSource}
              actions={actions as never}
              variables={[]}
              state={state}
              controls={null}
            />
          </RunActionsProvider>
        </CicdProvider>
      </ThemeProvider>,
    );
  });
  (show as unknown as { subtitles: typeof subtitles }).subtitles = subtitles;
}
const subtitlesOf = (): (string | null)[] => (show as unknown as { subtitles: (string | null)[] }).subtitles;
const lastChart = (): ChartProps => {
  const c = charts[charts.length - 1];
  if (c === undefined) throw new Error('no chart drawn');
  return c;
};
type S = { type: string; name?: string; stack?: string; data: { itemStyle: { color: string } }[] };
const on = (name: string): ((p: unknown) => void) | undefined =>
  Object.entries(lastChart().onEvents ?? {}).find(([k]) => k === name)?.[1];
const series = (): S[] => (lastChart().option as unknown as { series: S[] }).series;
const menuLabels = (): string[] =>
  [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent ?? '');

beforeEach(() => {
  state = EMPTY_DASHBOARD_STATE;
  selected = [];
  charts.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('stat', () => {
  it('shows the value and a delta against the same length before, better in green', async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) =>
        row(i + 1, 2 * DAY + i * SEC, { result: i < 3 ? 'success' : 'failure' }),
      ),
      ...Array.from({ length: 11 }, (_, i) =>
        row(i + 20, 8 * DAY + i * SEC, { result: i < 9 ? 'success' : 'failure' }),
      ),
    ];
    await show(widget('stat', { stat: 'success-rate' }), rows);
    expect(host.textContent).toContain('81.8%');
    expect(host.textContent).toContain('▲ 31.8 pts vs 7 days before');
    const delta = [...host.querySelectorAll('*')].find((e) => e.textContent?.startsWith('▲'));
    expect(delta?.className).toContain('text-good-ink');
  });

  it('colours a longer median run in the critical ink', async () => {
    const rows = [
      row(1, 2 * DAY, { end: 2 * DAY + 60 * SEC }),
      row(2, 8 * DAY, { end: 8 * DAY + 120 * SEC }),
    ];
    await show(widget('stat', { stat: 'median-run' }), rows);
    const delta = [...host.querySelectorAll('*')].find((e) => e.textContent?.startsWith('▲'));
    expect(delta?.className).toContain('text-critical');
  });

  it('says so with no run', async () => {
    await show(widget('stat', { stat: 'success-rate' }), []);
    expect(host.textContent).toContain('No run in this range.');
    expect(host.textContent).not.toMatch(/NaN|–%/);
  });
});

describe('runs-trend', () => {
  it('names the bucket and draws two lines over three stacked bars', async () => {
    await show(widget('runs-trend'), sevenDays());
    expect(subtitlesOf().at(-1)).toBe('2 days buckets');
    const s = series();
    expect(s.filter((x) => x.type === 'line').map((x) => x.name)).toEqual(['p50', 'p95']);
    const bars = s.filter((x) => x.type === 'bar');
    expect(bars.map((x) => x.name)).toEqual(['passed', 'failed', 'cancelled']);
    expect(new Set(bars.map((x) => x.stack)).size).toBe(1);
  });

  it('labels the x axis in local time without ISO text and shows a zero duration as 0 s', async () => {
    await show(widget('runs-trend'), sevenDays());
    const o = lastChart().option as unknown as {
      xAxis: { data: string[] };
      yAxis: { axisLabel: { formatter(v: number): string } }[];
    };
    expect(o.xAxis.data.length).toBeGreaterThan(0);
    for (const l of o.xAxis.data) expect(l).not.toMatch(/\d{4}-\d\d-\d\dT|\.\d{3}Z/);
    // two-day buckets: the date only
    expect(o.xAxis.data[0]).not.toMatch(/\d:\d\d/);
    expect(o.yAxis[0]?.axisLabel.formatter(0)).toBe('0 s');
  });

  it('offers "Zoom the slider to this bucket", which writes whole nanoseconds', async () => {
    await show(widget('runs-trend'), sevenDays());
    const handler = on('contextmenu');
    expect(handler).toBeDefined();
    await act(async () => handler?.({ dataIndex: 1, event: { event: { clientX: 5, clientY: 6 } } }));
    expect(menuLabels()).toContain('Zoom the slider to this bucket');
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) =>
      e.textContent?.startsWith('Zoom'),
    );
    await act(async () => item?.click());
    expect(selected).toHaveLength(1);
    const w = selected[0] as { start: number; end: number };
    expect(Number.isInteger(w.start) && Number.isInteger(w.end)).toBe(true);
    expect(w.end - w.start).toBe(2 * DAY);
  });

  it('says so with no run', async () => {
    await show(widget('runs-trend'), []);
    expect(host.textContent).toContain('No run in this range.');
    expect(charts).toHaveLength(0);
  });
});

const ring = (): { itemStyle: { opacity: number; borderWidth: number }; data: unknown[][] } | undefined =>
  series().find((x) => x.type === 'scatter') as never;
const open = (from: string): void => {
  state = {
    ...EMPTY_DASHBOARD_STATE,
    sel: { ...EMPTY_DASHBOARD_STATE.sel, trace: TRACE(3) as never },
    run: { from, mode: 'attached' },
  };
};

describe('the open run ring', () => {
  it('is full in the view the run was opened from (runs)', async () => {
    open('w1');
    await show(widget('runs'), sevenDays());
    expect(ring()?.itemStyle).toMatchObject({ opacity: 1, borderWidth: 2 });
    expect(ring()?.data[0]?.[0]).toBe(2);
  });

  it('is faint when another widget opened the run (runs)', async () => {
    open('other');
    await show(widget('runs'), sevenDays());
    expect(ring()?.itemStyle).toMatchObject({ opacity: 0.35, borderWidth: 1.5 });
  });

  it('is absent with no open run (runs, runs-trend)', async () => {
    await show(widget('runs'), sevenDays());
    expect(ring()).toBeUndefined();
    await show(widget('runs-trend'), sevenDays());
    expect(ring()).toBeUndefined();
  });

  it('rings the bucket that holds the run in runs-trend, faint or full', async () => {
    open('other');
    await show(widget('runs-trend'), sevenDays());
    expect(ring()?.itemStyle).toMatchObject({ opacity: 0.35, borderWidth: 1.5 });
    // the open run is the third of twelve in time: the bucket where the running count first reaches 3
    // (the first bucket may be a partial one, so the index is not fixed)
    const counts = series()
      .filter((x) => x.type === 'bar')
      .map((x) => x.data as unknown as number[]);
    let seen = 0;
    const third = (counts[0] ?? []).findIndex((_, i) => {
      seen += counts.reduce((n, c) => n + (c[i] ?? 0), 0);
      return seen >= 3;
    });
    expect(ring()?.data[0]?.[0]).toBe(third);
    open('w1');
    await show(widget('runs-trend'), sevenDays());
    expect(ring()?.itemStyle).toMatchObject({ opacity: 1, borderWidth: 2 });
  });
});

describe('runs', () => {
  it('draws one bar per run, hollow when no task was replayed, and opens a run on click', async () => {
    await show(widget('runs'), sevenDays());
    const bars = series().find((x) => x.type === 'bar');
    if (bars === undefined) throw new Error('no bars');
    expect(bars.data).toHaveLength(12);
    // run 1 replayed nothing (cached false): hollow; run 2 replayed a task (cached true): filled
    expect(bars.data[0]?.itemStyle.color).toBe('transparent');
    expect(bars.data[1]?.itemStyle.color).not.toBe('transparent');
    await act(async () => on('click')?.({ dataIndex: 2 }));
    expect(state.sel.trace).toBe(TRACE(3));
    expect(state.run?.from).toBe('w1');
  });

  it('opens the run menu on a right-click', async () => {
    await show(widget('runs'), sevenDays());
    await act(async () =>
      on('contextmenu')?.({ dataIndex: 0, event: { event: { clientX: 1, clientY: 2 } } }),
    );
    expect(menuLabels()).toContain('Open the run here');
  });

  it('says so with no run', async () => {
    await show(widget('runs'), []);
    expect(host.textContent).toContain('No run in this range.');
  });
});

describe('runs chart keyboard access', () => {
  const box = (): HTMLElement => {
    const el = q<HTMLElement>('[role="application"]');
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 452, height: 120, right: 452, bottom: 120, x: 0, y: 0 }) as DOMRect;
    return el;
  };
  const key = async (el: HTMLElement, k: string, init: KeyboardEventInit = {}): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
    });
  };
  const q = <T extends Element>(sel: string): T => {
    const e = host.querySelector<T>(sel);
    if (e === null) throw new Error(`nothing matches ${sel}`);
    return e;
  };
  const rows = (): CicdRow[] => sevenDays();

  it('makes the chart one labelled, focusable element', async () => {
    await show(widget('runs'), rows());
    const el = q<HTMLElement>('[role="application"]');
    expect(el.tabIndex).toBe(0);
    expect(el.getAttribute('aria-label')).toMatch(/Run durations/);
  });

  it('ArrowRight then Enter opens the second run, and the live region names it', async () => {
    await show(widget('runs'), rows());
    const el = box();
    await act(async () => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    await key(el, 'ArrowRight');
    await key(el, 'ArrowRight');
    expect(el.querySelector('[aria-live]')?.textContent).toMatch(/commit 2 · failure/);
    await key(el, 'Enter');
    expect(state.sel.trace).toBe(TRACE(2));
    expect(state.run?.from).toBe('w1');
  });

  it('draws a current-run ring while focused, on the run the arrows chose', async () => {
    await show(widget('runs'), rows());
    const el = box();
    await act(async () => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    await key(el, 'End');
    const ringOf = (): { data: number[][] } | undefined =>
      (series() as unknown as { id?: string; data: number[][] }[]).find((x) => x.id === 'current-run');
    expect(ringOf()?.data[0]?.[0]).toBe(11);
  });

  it('announces nothing after a blur, nor when the runs change', async () => {
    await show(widget('runs'), rows());
    const el = box();
    await act(async () => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    await key(el, 'ArrowRight');
    expect(el.querySelector('[aria-live]')?.textContent).not.toBe('');
    await act(async () => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(el.querySelector('[aria-live]')?.textContent).toBe('');
    await show(widget('runs'), [...rows()].reverse());
    expect(q('[aria-live]').textContent).toBe('');
  });

  it('keeps the current run when the runs shift under it', async () => {
    await show(widget('runs'), rows());
    const el = box();
    await act(async () => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    await key(el, 'ArrowRight');
    await key(el, 'ArrowRight');
    const before = el.querySelector('[aria-live]')?.textContent;
    await show(
      widget('runs'),
      rows().filter((r) => r.traceId !== TRACE(1)),
    );
    expect(q('[aria-live]').textContent).toBe(before);
  });

  it('suppresses the browser menu on the container', async () => {
    await show(widget('runs'), rows());
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => box().dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
  });

  it('ContextMenu and Shift+F10 open the run menu at the mark', async () => {
    await show(widget('runs'), rows());
    const el = box();
    await key(el, 'ArrowRight');
    await key(el, 'ContextMenu');
    expect(menuLabels()).toContain('Open the run here');
    await act(async () => document.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    await key(el, 'F10', { shiftKey: true });
    expect(menuLabels()).toContain('Open the run here');
  });
});

describe('re-render with unchanged data', () => {
  it('hands the chart the same option and handlers, so it does not setOption again', async () => {
    const w = widget('runs');
    const rows = sevenDays();
    await show(w, rows);
    const first = lastChart();
    await show(w, rows);
    const again = lastChart();
    expect(again.onEvents).toBe(first.onEvents);
    expect(again.option).toBe(first.option);
  });
});
