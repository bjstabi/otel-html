import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '../../../src/dashboards/schema.js';
import { RunActionsProvider, RunRing, useRunActions } from '../../../src/viewer/cicd/run-actions.js';
import type { CiJob, CiRun } from '../../../src/viewer/cicd/runs.js';
import type { DataSource } from '../../../src/viewer/data/data-source.js';
import { type DashboardPageState, EMPTY_DASHBOARD_STATE } from '../../../src/viewer/state/dashboard-state.js';

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
        dataSource={{ getTrace } as unknown as DataSource}
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

describe('openRun', () => {
  it('writes d.run and d.sel.trace, keeping the last mode', () => {
    act(() => api.openRun(run()));
    expect(state.sel.trace).toBe(TRACE);
    expect(state.run).toEqual({ from: 'w9', mode: 'attached' });
    state = { ...state, run: { from: 'w1', mode: 'panel' } };
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

describe('Open on GitHub', () => {
  it('resolves the run url from the root span resource and opens it', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    getTrace.mockResolvedValue(detail('https://github.com/o/r/actions/runs/7'));
    act(() => api.runMenu(run(), { x: 1, y: 1 }));
    await act(async () => item('Open on GitHub').click());
    expect(getTrace).toHaveBeenCalledWith(TRACE);
    expect(open).toHaveBeenCalledWith('https://github.com/o/r/actions/runs/7', '_blank', 'noopener');
  });

  it('shows a notice when the trace has no url', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    getTrace.mockResolvedValue(detail(null));
    act(() => api.runMenu(run(), { x: 1, y: 1 }));
    await act(async () => item('Open on GitHub').click());
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/no GitHub link/);
  });

  it('shows the notice when the trace fails to load', async () => {
    getTrace.mockRejectedValue(new Error('boom'));
    act(() => api.runMenu(run(), { x: 1, y: 1 }));
    await act(async () => item('Open on GitHub').click());
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/no GitHub link/);
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
