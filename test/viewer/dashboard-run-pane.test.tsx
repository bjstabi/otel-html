import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DashboardSchema } from '../../src/dashboards/schema.js';
import type { CicdRow } from '../../src/viewer/data/cicd-query.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { DashboardPageState } from '../../src/viewer/state/dashboard-state.js';
import { serializeUrlState } from '../../src/viewer/state/url-state.js';
import { currentD, dataSourceOf, manifestWith, renderShell } from './dashboard-shell.js';
import { detailOf, TRACE_ID, traceRow } from './trace-rows.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DASH = DashboardSchema.parse({
  id: 'ci',
  title: 'CI',
  variables: ['cicd.pipeline.trigger'],
  widgets: [
    { id: 'runs', type: 'cicd', view: 'runs', x: 0, y: 0, w: 12, h: 8 },
    { id: 'jobs', type: 'cicd', view: 'jobs', x: 0, y: 8, w: 12, h: 8 },
  ],
});
const blank: CicdRow = {
  kind: 'run',
  traceId: TRACE_ID,
  spanId: null,
  start: 1_000_000_000,
  end: 61_000_000_000,
  name: null,
  result: 'success',
  pipeline: null,
  runId: '1',
  attempt: 1,
  trigger: 'push',
  branch: 'main',
  revision: 'abc1234',
  title: 'Fix the thing',
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
const jobRow: CicdRow = { ...blank, kind: 'job', spanId: '0000000000000002', task: 'build', taskId: 'build' };

const runDetail = {
  ...detailOf([traceRow(1, null, 0, 60_000_000_000)]),
  resources: () => ({
    attributes: new Map([['cicd.pipeline.run.id', { kind: 'string' as const, value: '1' }]]),
    droppedAttributesCount: 0,
    schemaUrl: '',
  }),
};

function source(): DataSource {
  return {
    ...dataSourceOf(manifestWith([DASH]), {
      'cicd.pipeline.trigger': { values: ['push', 'schedule'], kind: 'string', capped: false },
    }),
    // a trigger binding takes the run out of the fetched rows, as the real query would
    cicdRows: (q) =>
      Promise.resolve(q.bindings.some((b) => b.key === 'cicd.pipeline.trigger') ? [] : [blank, jobRow]),
    getTrace: () => Promise.resolve(runDetail),
    percentileOf: () => Promise.resolve(null),
    metricsForResources: () => Promise.resolve([]),
  };
}

const open = (d: Partial<DashboardPageState>): string =>
  `#/dashboards/ci?${serializeUrlState({
    d: {
      vars: {},
      sel: { t: null, trace: TRACE_ID },
      follow: {},
      logView: {},
      run: { from: 'runs', mode: 'attached' },
      ...d,
    },
  })}`;

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const GRID_DASH = DashboardSchema.parse({
  id: 'ci',
  title: 'CI',
  variables: ['cicd.pipeline.trigger'],
  widgets: [
    { id: 'grid', type: 'cicd', view: 'status-grid', x: 0, y: 0, w: 12, h: 8 },
    { id: 'jobs', type: 'cicd', view: 'jobs', x: 0, y: 8, w: 12, h: 8 },
  ],
});
const gridSource = (): DataSource => ({
  ...source(),
  ...dataSourceOf(manifestWith([GRID_DASH]), {
    'cicd.pipeline.trigger': { values: ['push', 'schedule'], kind: 'string', capped: false },
  }),
  cicdRows: (q) =>
    Promise.resolve(q.bindings.some((b) => b.key === 'cicd.pipeline.trigger') ? [] : [blank, jobRow]),
  getTrace: () => Promise.resolve(runDetail),
  percentileOf: () => Promise.resolve(null),
  metricsForResources: () => Promise.resolve([]),
});
const boxed = (): void => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 1000,
    height: 200,
    right: 1000,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
};

describe('the caret and the connector (R36)', () => {
  test('the caret follows the clicked mark, the connector draws in the source widget only', async () => {
    boxed();
    renderShell('#/dashboards/ci', gridSource());
    const dot = await screen.findByRole('button', { name: /Fix the thing/ });
    await act(async () => {
      fireEvent.click(dot, { clientX: 250, clientY: 50 });
    });
    const pane = await screen.findByTestId('run-pane');
    await waitFor(() => expect(within(pane).getByTestId('run-caret').style.left).toBe('25%'));
    const connector = document.querySelector('[data-widget="grid"] [data-testid="run-connector"]');
    expect(connector).not.toBeNull();
    expect((connector as HTMLElement).style.left).toBe('25%');
    expect((connector as HTMLElement).style.top).toBe('25%');
    expect(document.querySelectorAll('[data-testid="run-connector"]')).toHaveLength(1);
  });

  test('the caret is measured from the source widget and pane rects', async () => {
    const box = (left: number, width: number): DOMRect =>
      ({
        left,
        width,
        right: left + width,
        top: 0,
        height: 200,
        bottom: 200,
        x: left,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('data-widget') === 'grid') return box(500, 400);
      if (this.getAttribute('data-testid') === 'run-pane') return box(0, 1000);
      return box(0, 1000);
    });
    renderShell('#/dashboards/ci', gridSource());
    const dot = await screen.findByRole('button', { name: /Fix the thing/ });
    await act(async () => {
      fireEvent.click(dot, { clientX: 700, clientY: 50 });
    });
    const pane = await screen.findByTestId('run-pane');
    await waitFor(() => expect(within(pane).getByTestId('run-caret').style.left).toBe('70%'));
  });

  test('without a point (a reload) the caret is centred and no connector draws', async () => {
    renderShell(open({ run: { from: 'grid', mode: 'attached' } }), gridSource());
    const pane = await screen.findByTestId('run-pane');
    expect(within(pane).getByTestId('run-caret').style.left).toBe('50%');
    expect(document.querySelector('[data-testid="run-connector"]')).toBeNull();
  });

  test('a reload of the source view keeps the pane and its Gantt; an empty answer hides the connector', async () => {
    boxed();
    let hold = true;
    const ds: DataSource = {
      ...gridSource(),
      cicdRows: (q) => {
        const bound = q.bindings.some((b) => b.key === 'cicd.pipeline.trigger');
        if (!bound) return Promise.resolve([blank, jobRow]);
        return hold ? new Promise(() => undefined) : Promise.resolve([]);
      },
    };
    renderShell('#/dashboards/ci', ds);
    const dot = await screen.findByRole('button', { name: /Fix the thing/ });
    await act(async () => {
      fireEvent.click(dot, { clientX: 250, clientY: 50 });
    });
    await screen.findByTestId('run-gantt');
    const d = currentD();
    await act(async () => {
      window.location.hash = `#/dashboards/ci?${serializeUrlState({ d: { ...(d as DashboardPageState), vars: { 'cicd.pipeline.trigger': 'schedule' } } })}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    // the read is still pending: the last run stays
    expect(screen.getByTestId('run-gantt')).toBeTruthy();
    expect(screen.queryByText('Loading the run…')).toBeNull();
    hold = false;
  });

  test('no connector once the run is outside the selection', async () => {
    boxed();
    renderShell('#/dashboards/ci', gridSource());
    const dot = await screen.findByRole('button', { name: /Fix the thing/ });
    await act(async () => {
      fireEvent.click(dot, { clientX: 250, clientY: 50 });
    });
    await waitFor(() => expect(document.querySelector('[data-testid="run-connector"]')).not.toBeNull());
    const d = currentD();
    await act(async () => {
      window.location.hash = `#/dashboards/ci?${serializeUrlState({ d: { ...(d as DashboardPageState), vars: { 'cicd.pipeline.trigger': 'schedule' } } })}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(screen.getByText('The run is outside the current selection')).toBeTruthy());
    expect(document.querySelector('[data-testid="run-connector"]')).toBeNull();
  });

  test('no connector in side-panel mode or when the run is outside the selection', async () => {
    boxed();
    renderShell('#/dashboards/ci', gridSource());
    const dot = await screen.findByRole('button', { name: /Fix the thing/ });
    await act(async () => {
      fireEvent.click(dot, { clientX: 250, clientY: 50 });
    });
    const pane = await screen.findByTestId('run-pane');
    await waitFor(() => expect(document.querySelector('[data-testid="run-connector"]')).not.toBeNull());
    await act(async () => {
      fireEvent.click(within(pane).getByRole('button', { name: /opens: attached/ }));
    });
    expect(document.querySelector('[data-testid="run-connector"]')).toBeNull();
  });
});

describe('the open run on a dashboard page', () => {
  test('attached, the pane shows the run with a caret and the mode pill', async () => {
    renderShell(open({}), source());
    const pane = await screen.findByTestId('run-pane');
    await waitFor(() => expect(within(pane).getByText(/Fix the thing/)).toBeTruthy());
    expect(within(pane).getByTestId('run-caret')).toBeTruthy();
    expect(within(pane).getByRole('button', { name: /opens: attached/ })).toBeTruthy();
    expect(screen.queryByTestId('trace-panel')).toBeNull();
  });

  test('switching to the side panel sets mode panel and opens the trace panel on Jobs; its close clears the run', async () => {
    renderShell(open({}), source());
    const pane = await screen.findByTestId('run-pane');
    await act(async () => {
      fireEvent.click(within(pane).getByRole('button', { name: /opens: attached/ }));
    });
    expect(currentD()?.run).toEqual({ from: 'runs', mode: 'panel' });
    const panel = await screen.findByTestId('trace-panel');
    expect(screen.queryByTestId('run-pane')).toBeNull();
    await waitFor(() =>
      expect(within(panel).getByRole('tab', { name: 'Jobs' }).getAttribute('aria-selected')).toBe('true'),
    );
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: /Close trace/ }));
    });
    expect(currentD()?.run ?? null).toBeNull();
    expect(currentD()?.sel.trace ?? null).toBeNull();
    expect(screen.queryByTestId('trace-panel')).toBeNull();
  });

  test('leaving the side panel puts the trace tab back to the one it found', async () => {
    renderShell(open({ run: { from: 'runs', mode: 'panel' } }).replace('?', '?tab=waterfall&'), source());
    const panel = await screen.findByTestId('trace-panel');
    await waitFor(() =>
      expect(within(panel).getByRole('tab', { name: 'Jobs' }).getAttribute('aria-selected')).toBe('true'),
    );
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: /Close trace/ }));
    });
    expect(window.location.hash).toContain('tab=waterfall');
  });

  test('the pane close clears the run and the trace', async () => {
    renderShell(open({}), source());
    const pane = await screen.findByTestId('run-pane');
    await act(async () => {
      fireEvent.click(within(pane).getByRole('button', { name: 'Close the run' }));
    });
    expect(currentD()?.run ?? null).toBeNull();
    expect(currentD()?.sel.trace ?? null).toBeNull();
    expect(screen.queryByTestId('run-pane')).toBeNull();
  });

  test('a run outside the current selection hides the caret and says so', async () => {
    renderShell(open({ vars: { 'cicd.pipeline.trigger': 'schedule' } }), source());
    const pane = await screen.findByTestId('run-pane');
    await waitFor(() =>
      expect(within(pane).getByText('The run is outside the current selection')).toBeTruthy(),
    );
    expect(within(pane).queryByTestId('run-caret')).toBeNull();
  });

  test('a run whose widget is not a cicd widget on the page is a stale id in the notice', async () => {
    renderShell(open({ run: { from: 'nope', mode: 'attached' } }), source());
    const notice = await screen.findByText(/This link refers to widgets or variables/);
    expect(notice.textContent).toContain('run.nope');
  });

  test('a run of a widget that is not cicd opens no pane', async () => {
    renderShell(open({ run: { from: 'nope', mode: 'attached' } }), source());
    await screen.findByText('CI');
    expect(screen.queryByTestId('run-pane')).toBeNull();
  });
});
