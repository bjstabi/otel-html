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
const LONG = 'a-job-name-that-is-far-longer-than-the-label-column-can-hold';

const dashboard = DashboardSchema.parse({
  id: 'ci',
  title: 'CI',
  variables: ['cicd.pipeline.task.name', 'cicd.pipeline.trigger'],
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

function run(i: number, start: number, over: Partial<CicdRow> = {}): CicdRow {
  return {
    ...blank,
    traceId: TRACE(i),
    runId: `r${i}`,
    start,
    end: start + 120 * SEC,
    title: `commit ${i}`,
    ...over,
  };
}
function job(i: number, start: number, name: string, over: Partial<CicdRow> = {}): CicdRow {
  return {
    ...blank,
    kind: 'job',
    traceId: TRACE(i),
    spanId: `${i}-${name}`.padEnd(16, '0').slice(0, 16),
    start: start + 5 * SEC,
    end: start + 65 * SEC,
    task: name,
    trigger: null,
    branch: null,
    revision: null,
    ...over,
  };
}

const widget = (view: string, extra: Record<string, unknown> = {}): Widget =>
  DashboardSchema.parse({
    id: 'ci',
    title: 'CI',
    widgets: [{ id: 'w1', type: 'cicd', view, x: 0, y: 0, w: 4, h: 6, ...extra }],
  }).widgets[0] as Widget;

let root: Root;
let host: HTMLElement;
let state: DashboardPageState;
let subtitles: (string | null)[];

/** `n` runs in the last 7 days, each with the jobs `names`; run 2 fails `test`. */
function runs(
  n: number,
  names: string[],
  over: (i: number) => Partial<CicdRow> = () => ({}),
  base = 0,
): CicdRow[] {
  return Array.from({ length: n }, (_, k) => k + 1).flatMap((i) => {
    const start = 7 * DAY + Math.round(((i - 0.5) * 7 * DAY) / n);
    const failed = i === 2;
    return [
      run(i + base, start, { result: failed ? 'failure' : 'success', ...over(i) }),
      ...names.map((name) =>
        job(i + base, start, name, {
          result: failed && name === 'test' ? 'failure' : 'success',
          failedStep: failed && name === 'test' ? 'cargo test' : null,
        }),
      ),
    ];
  });
}

async function show(w: Widget, rows: CicdRow[]): Promise<void> {
  const dataSource = {
    cicdRows: () => Promise.resolve(rows),
    manifest: { epochUnixNano: '1700000000000000000' },
    resourceValues: () => Promise.resolve({ values: [] }),
    getTrace: () => Promise.reject(new Error('no trace')),
  } as unknown as DataSource;
  subtitles = [];
  const actions = { selectWindow: () => {}, setSubtitle: (t: string | null) => subtitles.push(t) };
  await act(async () => {
    root.render(
      <ThemeProvider>
        <CicdProvider dataSource={dataSource} extent={{ start: 0, end: 14 * DAY }}>
          <RunActionsProvider
            dashboard={dashboard}
            state={state}
            change={(fn) => {
              state = fn(state);
            }}
            dataSource={dataSource}
            window={null}
          >
            <CicdWidget
              widget={w}
              scope={{ window: { start: 7 * DAY, end: 14 * DAY }, vars: [] } as never}
              dashboard={{} as never}
              height={400}
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
}

const menuLabels = (): string[] =>
  [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent ?? '');
const lastChart = (): ChartProps => {
  const c = charts[charts.length - 1];
  if (c === undefined) throw new Error('no chart drawn');
  return c;
};
const open = (from: string, i = 3): void => {
  state = {
    ...EMPTY_DASHBOARD_STATE,
    sel: { ...EMPTY_DASHBOARD_STATE.sel, trace: TRACE(i) as never },
    run: { from, mode: 'attached' },
  };
};
const q = <T extends Element>(sel: string): T => {
  const e = host.querySelector<T>(sel);
  if (e === null) throw new Error(`nothing matches ${sel}`);
  return e;
};

beforeEach(() => {
  state = EMPTY_DASHBOARD_STATE;
  charts.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('empty', () => {
  it.each(['jobs', 'status-grid', 'failures', 'triggers'])(
    '%s says so with no run, with no NaN',
    async (v) => {
      await show(widget(v), []);
      expect(host.textContent).toContain('No run in this range.');
      expect(host.textContent).not.toMatch(/NaN|–%/);
    },
  );
});

describe('jobs', () => {
  it('lists a row per job and says the baseline is too small', async () => {
    await show(widget('jobs'), runs(12, ['build', 'test']));
    expect(host.querySelectorAll('[data-job]')).toHaveLength(2);
    expect(host.textContent).toContain('baseline too small');
    expect(host.textContent).toContain('1 / 12');
    expect(subtitles.at(-1)).toBe('2 jobs');
  });

  it('expands the trend chart on a row click, and a point opens the run', async () => {
    await show(widget('jobs'), runs(12, ['build', 'test']));
    expect(charts).toHaveLength(0);
    await act(async () => q<HTMLElement>('[data-job="build"]').click());
    const chart = lastChart();
    const click = Object.entries(chart.onEvents ?? {}).find(([k]) => k === 'click')?.[1] as
      | ((p: unknown) => void)
      | undefined;
    await act(async () => click?.({ dataIndex: 4 }));
    expect(state.sel.trace).toBe(TRACE(5));
    expect(state.run?.from).toBe('w1');
    await act(async () => q<HTMLElement>('[data-job="build"]').click());
    expect(host.querySelector('[data-job-trend]')).toBeNull();
  });

  it('opens the job menu from the ⋯ button, with "Open its trend"', async () => {
    await show(widget('jobs'), runs(12, ['build', 'test']));
    await act(async () => q<HTMLElement>('[data-job="test"] button[aria-label="Job menu"]').click());
    expect(menuLabels()).toEqual(['Filter the page by job', 'Open its trend']);
  });

  it('rings the open run in the expanded trend, faint or full', async () => {
    open('other');
    await show(widget('jobs'), runs(12, ['build', 'test']));
    await act(async () => q<HTMLElement>('[data-job="build"]').click());
    const y = (lastChart().option as unknown as { yAxis: { max: number; interval: number } }).yAxis;
    expect(y.interval).toBeGreaterThan(0);
    expect(y.max).toBeGreaterThanOrEqual(Math.max(y.interval, 60 * SEC));
    expect(y.max % y.interval).toBe(0);
    const ring = (): { itemStyle: { opacity: number }; data: number[][] } | undefined =>
      (lastChart().option as unknown as { series: { type: string }[] }).series.find(
        (s) => s.type === 'scatter' && 'data' in s,
      ) as never;
    expect(ring()?.itemStyle.opacity).toBe(0.35);
    expect(ring()?.data[0]?.[0]).toBe(2);
    open('w1');
    await show(widget('jobs'), runs(12, ['build', 'test']));
    expect(ring()?.itemStyle.opacity).toBe(1);
  });
});

describe('status-grid', () => {
  it('has 60 columns at most, one dot per run', async () => {
    await show(widget('status-grid'), runs(70, ['build']));
    expect(host.querySelectorAll('[data-run-dot]')).toHaveLength(60);
    expect(host.querySelectorAll('[data-cell]').length).toBe(60);
    expect(subtitles.at(-1)).toBe('last 60 runs');
  });

  it('opens the run of a failed cell on a click', async () => {
    await show(widget('status-grid'), runs(12, ['build', 'test']));
    const cell = q<SVGElement>('[data-job-row="test"] [data-cell="failure"]');
    await act(async () => cell.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(state.sel.trace).toBe(TRACE(2));
    expect(state.run?.from).toBe('w1');
  });

  it('exposes the run dots to assistive technology as buttons inside a labelled group', async () => {
    await show(widget('status-grid'), runs(12, ['build', 'test']));
    const group = q<SVGElement>('[role="group"]');
    expect(group.getAttribute('aria-label')).toMatch(/Job results/);
    expect(host.querySelector('[role="img"]')).toBeNull();
    expect(group.querySelectorAll('[role="button"]')).toHaveLength(12);
  });

  it('puts one run dot in the tab order and no cell', async () => {
    await show(widget('status-grid'), runs(12, ['build', 'test']));
    const dots = [...host.querySelectorAll('[data-run-dot]')];
    expect(dots.filter((d) => d.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(dots.filter((d) => d.getAttribute('tabindex') === '-1')).toHaveLength(11);
    for (const cell of host.querySelectorAll('[data-cell]'))
      expect(cell.hasAttribute('tabindex')).toBe(false);
  });

  it('moves the tab stop with the arrows, Home and End', async () => {
    await show(widget('status-grid'), runs(12, ['build']));
    const dots = (): Element[] => [...host.querySelectorAll('[data-run-dot]')];
    const press = async (el: Element, key: string): Promise<void> => {
      await act(async () => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    };
    await press(dots()[0] as Element, 'ArrowRight');
    expect(dots()[1]?.getAttribute('tabindex')).toBe('0');
    await press(dots()[1] as Element, 'End');
    expect(dots()[11]?.getAttribute('tabindex')).toBe('0');
    await press(dots()[11] as Element, 'ArrowLeft');
    expect(dots()[10]?.getAttribute('tabindex')).toBe('0');
    await press(dots()[10] as Element, 'Home');
    expect(dots()[0]?.getAttribute('tabindex')).toBe('0');
  });

  it.each(['Enter', ' '])('opens the run of a dot on %j', async (key) => {
    await show(widget('status-grid'), runs(12, ['build', 'test']));
    const dot = q<SVGElement>(`[data-run-dot]:nth-of-type(2)`);
    await act(async () => dot.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    expect(state.sel.trace).toBe(TRACE(2));
    expect(state.run?.from).toBe('w1');
  });

  it('opens the job menu from the whole label box, not only its glyphs (WebKit hit-tests SVG text by glyph)', async () => {
    await show(widget('status-grid'), runs(12, ['build', 'test']));
    const hit = q<SVGRectElement>('[data-job-row="test"] rect[data-label-hit]');
    expect(hit.getAttribute('fill')).toBe('transparent');
    await act(async () =>
      hit.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      ),
    );
    expect(menuLabels()).toContain('Filter the page by job');
  });

  it('opens the run menu of a dot on Shift+F10', async () => {
    await show(widget('status-grid'), runs(12, ['build', 'test']));
    const dot = q<SVGElement>('[data-run-dot]');
    await act(async () =>
      dot.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })),
    );
    expect(menuLabels()).toContain('Open the run here');
  });

  it('truncates a long label with … and keeps the full name in a <title>', async () => {
    await show(widget('status-grid'), runs(12, [LONG]));
    const label = q<SVGTextElement>('[data-job-row] text');
    const shown = label.firstChild?.textContent ?? '';
    expect(shown).toMatch(/…$/);
    expect(shown.length).toBeLessThan(LONG.length);
    expect(label.querySelector('title')?.textContent).toBe(LONG);
  });

  it('rings the open run column, faint or full', async () => {
    open('other');
    await show(widget('status-grid'), runs(12, ['build']));
    expect(q('[data-run-ring]').getAttribute('data-run-ring')).toBe('faint');
    open('w1');
    await show(widget('status-grid'), runs(12, ['build']));
    expect(q('[data-run-ring]').getAttribute('data-run-ring')).toBe('full');
  });
});

describe('failures', () => {
  const failing = (): CicdRow[] =>
    runs(12, ['build', 'test'], (i) =>
      i === 9 ? { result: 'failure', trigger: 'pull_request', branch: 'fix-x' } : {},
    ).map((r) =>
      r.kind === 'job' && r.traceId === TRACE(9) && r.task === 'build' ? { ...r, result: 'failure' } : r,
    );

  it('lists failed runs latest first with trigger and branch under the title', async () => {
    await show(widget('failures'), failing());
    const rows = [...host.querySelectorAll('[data-failure]')];
    expect(rows.map((r) => r.getAttribute('data-failure'))).toEqual([TRACE(9), TRACE(2)]);
    expect(rows[0]?.textContent).toContain('commit 9');
    expect(rows[0]?.textContent).toContain('pull_request · fix-x');
    expect(subtitles.at(-1)).toBe('2 failed runs');
  });

  it('says how many failed runs there are when the list is capped at 10', async () => {
    const rows = runs(25, ['build'], () => ({ result: 'failure' }));
    await show(widget('failures'), rows);
    expect(host.querySelectorAll('[data-failure]')).toHaveLength(10);
    expect(subtitles.at(-1)).toBe('latest 10 of 25 failed runs');
  });

  it('opens the job menu from a failed-job chip, and shows the failing step on hover', async () => {
    await show(widget('failures'), failing());
    const chip = q<HTMLElement>(`[data-failure="${TRACE(2)}"] [data-job-chip="test"]`);
    expect(chip.title).toContain('cargo test');
    await act(async () => chip.click());
    expect(menuLabels()).toContain('Filter the page by job');
    expect(state.run).toBeNull();
  });

  it('shows the run time as a short local date and time on one line', async () => {
    await show(widget('failures'), failing());
    const when = q<HTMLElement>(`[data-failure="${TRACE(2)}"] span`);
    expect(when.textContent).not.toMatch(/\d{4}-\d\d-\d\dT|\.\d{3}Z/);
    expect(when.className).toContain('whitespace-nowrap');
  });

  it('opens a keyboard-activated chip menu at the chip, not at the screen corner', async () => {
    await show(widget('failures'), failing());
    const chip = q<HTMLElement>(`[data-failure="${TRACE(2)}"] [data-job-chip="test"]`);
    chip.getBoundingClientRect = () =>
      ({ left: 200, top: 100, width: 40, height: 20, right: 240, bottom: 120, x: 200, y: 100 }) as DOMRect;
    await act(async () => chip.click());
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.style.left).toBe('220px');
    expect(menu?.style.top).toBe('110px');
  });

  it('opens a run on a row click and rings it in the row', async () => {
    open('other', 2);
    await show(widget('failures'), failing());
    expect(q(`[data-failure="${TRACE(2)}"]`).getAttribute('data-run-ring')).toBe('faint');
    expect(q(`[data-failure="${TRACE(9)}"]`).hasAttribute('data-run-ring')).toBe(false);
    open('w1', 2);
    await show(widget('failures'), failing());
    expect(q(`[data-failure="${TRACE(2)}"]`).getAttribute('data-run-ring')).toBe('full');
    await act(async () => q<HTMLElement>(`[data-failure="${TRACE(9)}"]`).click());
    expect(state.sel.trace).toBe(TRACE(9));
  });

  it('says the run has no GitHub link when the lookup fails', async () => {
    await show(widget('failures'), failing());
    await act(async () =>
      q<HTMLElement>(`[data-failure="${TRACE(2)}"] button[aria-label="Open on GitHub"]`).click(),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('This run has no GitHub link.');
  });
});

describe('triggers', () => {
  const extras = Array.from({ length: 7 }, (_, k) => `extra${k}`);
  // 20 pull requests start lint and seven more jobs, all but the fifth also the seven
  const mixed = (): CicdRow[] => [
    ...runs(3, ['build', 'test']),
    ...runs(20, ['lint', ...extras], () => ({ trigger: 'pull_request' }), 100).filter(
      (r) => !(r.traceId === TRACE(105) && r.task?.startsWith('extra') === true),
    ),
  ];

  it('reads "all N" when every job always ran and folds equal shares into one chip', async () => {
    await show(widget('triggers'), mixed());
    const push = q('[data-trigger="push"]');
    expect(push.textContent).toContain('all 2');
    const pr = q('[data-trigger="pull_request"]');
    expect(pr.textContent).toContain('7 jobs 95%');
    expect(pr.textContent).toContain('1 of 8 always');
    expect(subtitles.at(-1)).toBe('2 triggers');
  });

  it('gives the jobs condition in the chip title', async () => {
    const rows = mixed().map((r) =>
      r.task?.startsWith('extra') === true ? { ...r, condition: 'github.ref == main' } : r,
    );
    await show(widget('triggers'), rows);
    const chip = q<HTMLElement>('[data-trigger="pull_request"] [title*="19 of 20"]');
    expect(chip.title).toContain('github.ref == main');
  });

  it('opens the trigger menu on a click on the trigger name', async () => {
    await show(widget('triggers'), mixed());
    await act(async () => q<HTMLElement>('[data-trigger="push"] button[data-trigger-name]').click());
    expect(menuLabels()[0]).toMatch(/^Filter the page by trigger/);
  });
});

describe('keyboard access to an expanded job trend', () => {
  it('ArrowRight then Enter on the trend opens the first run of the job', async () => {
    await show(widget('jobs'), runs(12, ['build', 'test']));
    await act(async () => q<HTMLElement>('[data-job="test"]').click());
    const el = q<HTMLElement>('[data-job-trend]');
    expect(el.getAttribute('role')).toBe('application');
    el.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 100, right: 400, bottom: 100, x: 0, y: 0 }) as DOMRect;
    await act(async () =>
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    await act(async () => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(state.sel.trace).toBe(TRACE(1));
    expect(state.run?.from).toBe('w1');
  });
});
