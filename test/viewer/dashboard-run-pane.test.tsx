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

  test('a run of a widget that is not cicd opens no pane', async () => {
    renderShell(open({ run: { from: 'nope', mode: 'attached' } }), source());
    await screen.findByText('CI');
    expect(screen.queryByTestId('run-pane')).toBeNull();
  });
});
