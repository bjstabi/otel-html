import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '../../../src/dashboards/schema.js';
import { RunActionsProvider, RunRing, useRunActions } from '../../../src/viewer/cicd/run-actions.js';
import type { CiJob, CiRun } from '../../../src/viewer/cicd/runs.js';
import type { DataSource } from '../../../src/viewer/data/data-source.js';
import {
  type DashboardPageState,
  EMPTY_DASHBOARD_STATE,
  withoutStaleRun,
} from '../../../src/viewer/state/dashboard-state.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TRACE = 'a'.repeat(32);
const BRANCH = 'vcs.ref.head.name';
const TRIGGER = 'cicd.pipeline.trigger';
const JOB = 'cicd.pipeline.task.name';
const RUNNER = 'cicd.worker.labels';

const dashboard = {
  id: 'ci',
  title: 'CI',
  description: '',
  variables: [BRANCH, TRIGGER, JOB, RUNNER].map((key) => ({ key, label: key, default: null })),
  quick: [
    { label: 'main', set: { [BRANCH]: 'main', [TRIGGER]: null } },
    { label: 'pull requests', set: { [TRIGGER]: 'pull_request', [BRANCH]: null } },
  ],
  widgets: [],
} as unknown as Dashboard;

const job = (name: string, result: string): CiJob => ({
  name,
  id: null,
  result,
  start: 0,
  end: 1,
  queuedNs: null,
  labels: null,
  needs: [],
  condition: null,
  failedStep: null,
  spanId: null,
});
const run = (over: Partial<CiRun> = {}): CiRun => ({
  traceId: TRACE,
  runId: '7',
  attempt: 1,
  attempts: 1,
  start: 0,
  duration: 1,
  result: 'failure',
  trigger: 'pull_request',
  branch: 'feat',
  revision: 'abc',
  title: 'fix it',
  jobs: [job('lint', 'failure'), job('unit', 'failure'), job('e2e', 'failure'), job('build', 'success')],
  minutes: 1,
  replayed: 0,
  ran: 1,
  cached: false,
  ...over,
});

let root: Root;
let host: HTMLElement;
let api: ReturnType<typeof useRunActions>;
let state: DashboardPageState;
let getTrace: ReturnType<typeof vi.fn>;
let resourceValues: ReturnType<typeof vi.fn>;

function Probe(): React.JSX.Element {
  api = useRunActions('w9');
  return <div>{api.element}</div>;
}

const render = (): void =>
  act(() =>
    root.render(
      <RunActionsProvider
        dashboard={dashboard}
        state={state}
        change={(fn) => {
          state = fn(state);
        }}
        dataSource={{ getTrace, resourceValues } as unknown as DataSource}
        window={null}
      >
        <Probe />
      </RunActionsProvider>,
    ),
  );
const labels = (): string[] =>
  [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent ?? '');
const item = (text: string): HTMLElement => {
  const el = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) =>
    e.textContent?.startsWith(text),
  );
  if (el === undefined) throw new Error(`no item ${text}`);
  return el;
};
const detail = (url: string | null, rootless = false): unknown => ({
  tree: { roots: rootless ? [] : [{ row: { span: { resource: 'r' } } }] },
  resources: () => ({
    attributes: new Map(url === null ? [] : [['cicd.pipeline.run.url.full', { kind: 'string', value: url }]]),
  }),
});

beforeEach(() => {
  state = EMPTY_DASHBOARD_STATE;
  getTrace = vi.fn();
  resourceValues = vi
    .fn()
    .mockResolvedValue({ values: ['https://github.com/a/b', 'https://github.com/c/d'] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  render();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('openRun point', () => {
  const widgetBox = (): HTMLElement => {
    const el = document.createElement('section');
    el.setAttribute('data-widget', 'w9');
    el.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200 }) as DOMRect;
    document.body.append(el);
    return el;
  };

  it('stores the mark as fractions of the source widget box, without touching the URL state', () => {
    const el = widgetBox();
    act(() => api.openRun(run(), { x: 200, y: 100 }));
    el.remove();
    expect(api.runPoint).toEqual({ x: 0.25, y: 0.25 });
    expect(JSON.stringify(state)).not.toContain('0.25');
  });

  it('has no point when none is given or the widget has no box', () => {
    act(() => api.openRun(run()));
    expect(api.runPoint).toBeNull();
    act(() => api.openRun(run(), { x: 5, y: 5 }));
    expect(api.runPoint).toBeNull();
  });
});

describe('openRun', () => {
  it('writes d.run and d.sel.trace', () => {
    act(() => api.openRun(run()));
    expect(state.sel.trace).toBe(TRACE);
    expect(state.run).toEqual({ from: 'w9', mode: 'attached' });
  });

  it('keeps the last mode as page-session state, also after d.run was cleared', () => {
    act(() => api.openRun(run()));
    act(() => api.setMode('panel'));
    expect(state.run?.mode).toBe('panel');
    state = withoutStaleRun(state, { ...state, sel: { t: null, trace: null } });
    expect(state.run).toBeNull();
    render();
    act(() => api.openRun(run()));
    expect(state.run).toEqual({ from: 'w9', mode: 'panel' });
  });

  it('reports the open run and whether this widget is its source', () => {
    expect(api.selectedTraceId).toBeNull();
    state = { ...state, sel: { t: null, trace: TRACE as never }, run: { from: 'w9', mode: 'attached' } };
    render();
    expect(api.selectedTraceId).toBe(TRACE);
    expect(api.isSource).toBe(true);
  });
});

describe('runMenu', () => {
  it('lists the items for a failed pull-request run, at most two failed jobs', () => {
    act(() => api.runMenu(run(), { x: 1, y: 1 }));
    expect(labels()).toEqual([
      'Open the run here',
      'Open on GitHub ↗',
      'Filter the page by triggerpull_request',
      'Show main only',
      'Filter the page by joblint',
      'Filter the page by jobunit',
    ]);
  });

  it('shows the pull-request quick filter for a main run', () => {
    act(() => api.runMenu(run({ trigger: 'push', branch: 'main', result: 'success' }), { x: 1, y: 1 }));
    expect(labels()).toContain('Show pull requests only');
    expect(labels()).not.toContain('Show main only');
  });

  it('omits the Show only item when the dashboard has no matching quick filter', () => {
    const saved = dashboard.quick;
    (dashboard as { quick: unknown }).quick = [];
    try {
      act(() => api.runMenu(run(), { x: 1, y: 1 }));
      expect(labels().some((l) => l.startsWith('Show '))).toBe(false);
    } finally {
      (dashboard as { quick: unknown }).quick = saved;
    }
  });

  it('applies the choices through the variables', () => {
    act(() => api.runMenu(run(), { x: 1, y: 1 }));
    act(() => item('Show main only').click());
    expect(state.vars).toEqual({ [BRANCH]: 'main' });
    act(() => api.runMenu(run(), { x: 1, y: 1 }));
    act(() => item('Filter the page by job').click());
    expect(state.vars[JOB]).toBe('lint');
    act(() => api.runMenu(run(), { x: 1, y: 1 }));
    act(() => item('Open the run here').click());
    expect(state.sel.trace).toBe(TRACE);
  });
});

describe('withoutStaleRun', () => {
  const open = {
    ...EMPTY_DASHBOARD_STATE,
    sel: { t: null, trace: TRACE as never },
    run: { from: 'w1', mode: 'attached' as const },
  };
  it('clears run when the trace is removed or replaced by another path', () => {
    expect(withoutStaleRun(open, { ...open, sel: { ...open.sel, trace: null } }).run).toBeNull();
    expect(
      withoutStaleRun(open, { ...open, sel: { ...open.sel, trace: 'b'.repeat(32) as never } }).run,
    ).toBeNull();
  });
  it('keeps run when the trace is unchanged or openRun set a new run', () => {
    expect(withoutStaleRun(open, { ...open, vars: { a: 'b' } }).run).toBe(open.run);
    const reopened = { ...open, run: { from: 'w2', mode: 'attached' as const } };
    expect(withoutStaleRun(open, reopened).run).toBe(reopened.run);
  });
});

describe('Open on GitHub', () => {
  const fakeTab = (): { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> } => ({
    opener: 'parent',
    location: { href: '' },
    close: vi.fn(),
  });
  const click = async (): Promise<void> => {
    act(() => api.runMenu(run(), { x: 1, y: 1 }));
    await act(async () => item('Open on GitHub').click());
  };

  it('opens the tab inside the click, before the url is known, and sends it there afterwards', async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as never);
    let resolve: (d: unknown) => void = () => {};
    getTrace.mockReturnValue(new Promise((r) => (resolve = r)));
    act(() => api.runMenu(run(), { x: 1, y: 1 }));
    await act(async () => item('Open on GitHub').click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe('');
    await act(async () => resolve(detail('https://github.com/o/r/actions/runs/7')));
    expect(getTrace).toHaveBeenCalledWith(TRACE);
    expect(tab.location.href).toBe('https://github.com/o/r/actions/runs/7');
  });

  it('refuses a url that is not http(s): the tab is closed and the notice shown', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    getTrace.mockResolvedValue(detail('javascript:alert(1)'));
    await click();
    expect(tab.location.href).toBe('');
    expect(tab.close).toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/no GitHub link/);
  });

  it('portals the notice to the body', async () => {
    vi.spyOn(window, 'open').mockReturnValue(fakeTab() as never);
    getTrace.mockResolvedValue(detail(null));
    await click();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(document.body.querySelector(':scope > [role="status"]')).not.toBeNull();
  });

  it('opens the url itself when the browser refused the early tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    getTrace.mockResolvedValue(detail('https://github.com/o/r/actions/runs/7'));
    await click();
    expect(open).toHaveBeenLastCalledWith('https://github.com/o/r/actions/runs/7', '_blank', 'noopener');
  });

  it('shows a notice and closes the tab when the trace has no url', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    getTrace.mockResolvedValue(detail(null));
    await click();
    expect(tab.close).toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/no GitHub link/);
  });

  it('shows the notice when the trace fails to load', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    getTrace.mockRejectedValue(new Error('boom'));
    await click();
    expect(tab.close).toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/no GitHub link/);
  });
});

describe('Open on GitHub from the repository', () => {
  const REPO = 'vcs.repository.url.full';
  const menu = async (r: CiRun = run()): Promise<void> => {
    await act(async () => api.runMenu(r, { x: 1, y: 1 }));
  };
  const closeMenu = (): void => {
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
  };

  it('reads the repository once per page, when a menu opens', async () => {
    resourceValues.mockResolvedValue({ values: ['https://github.com/o/r'] });
    await menu();
    expect(resourceValues).toHaveBeenCalledTimes(1);
    expect(resourceValues).toHaveBeenCalledWith(REPO, { window: null });
    closeMenu();
    await menu();
    expect(resourceValues).toHaveBeenCalledTimes(1);
  });

  it('opens the derived url in the click, with no blank tab and no trace read, once settled', async () => {
    resourceValues.mockResolvedValue({ values: ['https://github.com/o/r'] });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await menu();
    await act(async () => item('Open on GitHub').click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/actions/runs/7', '_blank', 'noopener');
    expect(getTrace).not.toHaveBeenCalled();
  });

  it('opens the blank tab in the click while pending and sends it to the derived url', async () => {
    let resolve: (v: unknown) => void = () => {};
    resourceValues.mockReturnValue(new Promise((r) => (resolve = r)));
    const tab = { opener: 'parent', location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as never);
    await menu();
    await act(async () => item('Open on GitHub').click());
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe('');
    await act(async () => resolve({ values: ['https://github.com/o/r'] }));
    expect(tab.location.href).toBe('https://github.com/o/r/actions/runs/7');
    expect(getTrace).not.toHaveBeenCalled();
  });

  it.each([
    ['two repositories', () => resourceValues.mockResolvedValue({ values: ['https://a/x', 'https://b/y'] })],
    ['a failed read', () => resourceValues.mockRejectedValue(new Error('boom'))],
    ['a non-http value', () => resourceValues.mockResolvedValue({ values: ['git@github.com:o/r'] })],
  ])('reads the trace with %s', async (_name, arrange) => {
    arrange();
    const tab = { opener: 'parent', location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    getTrace.mockResolvedValue(detail('https://github.com/o/r/actions/runs/7'));
    await menu();
    await act(async () => item('Open on GitHub').click());
    expect(getTrace).toHaveBeenCalledWith(TRACE);
    expect(tab.location.href).toBe('https://github.com/o/r/actions/runs/7');
  });

  it('reads the trace for a run whose id is not numeric, even with a repository', async () => {
    resourceValues.mockResolvedValue({ values: ['https://github.com/o/r'] });
    const tab = { opener: 'parent', location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as never);
    getTrace.mockResolvedValue(detail('https://github.com/o/r/actions/runs/99'));
    await menu(run({ runId: TRACE }));
    await act(async () => item('Open on GitHub').click());
    expect(getTrace).toHaveBeenCalledWith(TRACE);
    expect(tab.location.href).toBe('https://github.com/o/r/actions/runs/99');
  });
});

describe('the other menus', () => {
  it('a job: filters, then clears; the trend item only when given', () => {
    act(() => api.jobMenu('lint', { x: 1, y: 1 }));
    expect(labels()).toEqual(['Filter the page by job']);
    act(() => item('Filter the page by job').click());
    expect(state.vars[JOB]).toBe('lint');
    render();
    const trend = vi.fn();
    act(() => api.jobMenu('lint', { x: 1, y: 1 }, trend));
    expect(labels()).toEqual(['Clear the job filter', 'Open its trend']);
    act(() => item('Open its trend').click());
    expect(trend).toHaveBeenCalled();
    render();
    act(() => api.jobMenu('lint', { x: 1, y: 1 }));
    act(() => item('Clear the job filter').click());
    expect(state.vars[JOB]).toBeUndefined();
  });

  it('a trigger and a runner', () => {
    act(() => api.triggerMenu('push', { x: 1, y: 1 }));
    act(() => item('Filter the page by trigger').click());
    expect(state.vars[TRIGGER]).toBe('push');
    act(() => api.runnerMenu('ubuntu', { x: 1, y: 1 }));
    act(() => item('Filter the page by runner').click());
    expect(state.vars[RUNNER]).toBe('ubuntu');
  });
});

describe('RunRing', () => {
  const ring = (source: boolean): SVGGElement | null => {
    act(() =>
      root.render(
        <svg>
          <title>t</title>
          <RunRing cx={10} cy={10} r={4} source={source} connectorTo={50} />
        </svg>,
      ),
    );
    return host.querySelector('g[data-run-ring]');
  };
  it('is faint everywhere and full with a dotted connector in the source view', () => {
    const faint = ring(false);
    expect(faint?.getAttribute('data-run-ring')).toBe('faint');
    expect(faint?.querySelector('line')).toBeNull();
    const full = ring(true);
    expect(full?.getAttribute('data-run-ring')).toBe('full');
    expect(full?.querySelector('line')?.getAttribute('stroke-dasharray')).toBe('1 3');
  });
});
