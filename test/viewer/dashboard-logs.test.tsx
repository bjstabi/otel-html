import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string }): React.JSX.Element => <div role="img" aria-label={p.ariaLabel} />,
}));

import { DashboardSchema } from '../../src/dashboards/schema.js';
import type { WidgetActions } from '../../src/viewer/dashboards/dashboard-page.js';
import type { WidgetScope } from '../../src/viewer/dashboards/scope.js';
import { LogsWidget } from '../../src/viewer/dashboards/widgets/logs.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { LogQuery, LogQueryResult } from '../../src/viewer/data/results.js';
import { EMPTY_DASHBOARD_STATE } from '../../src/viewer/state/dashboard-state.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { baseManifest, currentD, dataSourceOf, emptyLogResult, renderShell } from './dashboard-shell.js';
import { FIXTURE_TRACE, fusionSource } from './fusion-source.js';

const LINKED_TRACE = FIXTURE_TRACE;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const linked = (): Promise<DataSource> => Promise.resolve(fusionSource());

/** The widget frame by its id (the sidebar has regions with the same names). */
function regionEl(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-widget="${name.toLowerCase()}"]`);
  if (el === null) throw new Error(`no ${name} widget`);
  return el;
}
const region = (name: string) => within(regionEl(name));

/** Fusion with the one linked trace selected through the Traces widget. */
async function withTraceSelected() {
  const user = userEvent.setup();
  renderShell('#/dashboards/fusion', await linked());
  const traces = await waitFor(() => {
    const r = region('Traces');
    expect(r.getAllByRole('row').length).toBeGreaterThan(1);
    return r;
  });
  const row = traces.getAllByRole('row')[1];
  if (row === undefined) throw new Error('no row');
  await user.click(row);
  await waitFor(() => expect(currentD()?.sel.trace).toBe(LINKED_TRACE));
  return user;
}

describe('the Logs widget', () => {
  test('lists every log in the window until a trace is selected', async () => {
    renderShell('#/dashboards/fusion', await linked());
    await waitFor(() => expect(region('Logs').getByText('charge declined')).toBeTruthy());
    const logs = region('Logs');
    expect(logs.getByText('web log')).toBeTruthy();
  });

  test('follows the selected trace: only its logs, "N logs for the selected trace"; ⛓ off lists them all', async () => {
    const user = await withTraceSelected();
    const logs = region('Logs');
    await waitFor(() => expect(logs.queryByText('web log')).toBeNull());
    expect(logs.getByText('charge declined')).toBeTruthy();
    expect(regionEl('Logs').textContent).toContain('1 log for the selected trace');
    await user.click(logs.getByRole('button', { name: /follows selection/ }));
    await waitFor(() => expect(logs.getByText('web log')).toBeTruthy());
    expect(regionEl('Logs').textContent).not.toContain('for the selected trace');
  });

  test('Show context lists every log in the window and marks the matching rows', async () => {
    const user = await withTraceSelected();
    const logs = region('Logs');
    await waitFor(() => expect(logs.queryByText('web log')).toBeNull());
    const matches = logs.getByRole('button', { name: 'Only matches' });
    expect(matches.getAttribute('aria-pressed')).toBe('true');
    await user.click(logs.getByRole('button', { name: 'Show context' }));
    expect(currentD()?.logView).toEqual({ logs: 'context' });
    await waitFor(() => expect(logs.getByText('web log')).toBeTruthy());
    const rowOf = (text: string): HTMLElement | null => logs.getByText(text).closest('[role="row"]');
    expect(rowOf('charge declined')?.hasAttribute('data-match')).toBe(true);
    expect(rowOf('web log')?.hasAttribute('data-match')).toBe(false);
    expect(rowOf('web log')?.hasAttribute('data-muted')).toBe(true);
    expect(rowOf('charge declined')?.hasAttribute('data-muted')).toBe(false);
  });

  test('a log row click opens the log panel through the selection store', async () => {
    const user = userEvent.setup();
    renderShell('#/dashboards/fusion', await linked());
    await waitFor(() => expect(region('Logs').getByText('charge declined')).toBeTruthy());
    await user.click(region('Logs').getByText('charge declined'));
    await waitFor(() => expect(parseUrlState(window.location.hash).state.log).toBe('0.0'));
  });

  test('Open in Logs navigates with the trace condition, and that page shows it', async () => {
    const user = await withTraceSelected();
    const logs = region('Logs');
    await waitFor(() => expect(logs.queryByText('web log')).toBeNull());
    await user.click(logs.getByRole('button', { name: /Open in Logs/ }));
    await waitFor(() => expect(window.location.hash.startsWith('#/logs')).toBe(true));
    expect(parseUrlState(window.location.hash).state.q).toBe(`trace_id.string == "${LINKED_TRACE}"`);
    const value = await screen.findByLabelText('Value of trace_id.string');
    expect((value as HTMLInputElement).value).toBe(LINKED_TRACE);
  });
});

const SCOPE: WidgetScope = {
  window: null,
  narrowed: false,
  band: null,
  traceFilter: null,
  highlightTrace: null,
  condition: null,
  outside: false,
};

function mount(
  ds: DataSource,
  opts: { scope?: Partial<WidgetScope>; logView?: 'matches' | 'context' } = {},
): WidgetActions {
  const dashboard = DashboardSchema.parse({
    id: 'd',
    title: 'D',
    widgets: [{ type: 'logs', x: 0, y: 0, w: 5, h: 13 }],
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
    <ThemeProvider>
      <SelectionProvider store={createSelectionStore({})}>
        <LogsWidget
          widget={w}
          scope={{ ...SCOPE, ...opts.scope }}
          dashboard={{ dashboard, source: 'x', isDefault: false }}
          height={400}
          dataSource={ds}
          actions={actions}
          variables={[]}
          controls={null}
          state={{
            ...EMPTY_DASHBOARD_STATE,
            logView: opts.logView === undefined ? {} : { logs: opts.logView },
          }}
        />
      </SelectionProvider>
    </ThemeProvider>,
  );
  return actions;
}

describe('the Logs widget states', () => {
  test('loading shows a status and no rows', () => {
    mount({ ...dataSourceOf(baseManifest), queryLogs: () => new Promise<LogQueryResult>(() => {}) });
    expect(screen.getByRole('status').textContent).toBe('Loading');
    expect(screen.queryByRole('grid')).toBeNull();
  });

  test('an empty result says no logs match', async () => {
    mount(dataSourceOf(baseManifest));
    expect((await screen.findByRole('heading', { name: 'No logs match' })).tagName).toBe('H3');
  });

  test('asks for the rows only, with a signal and no progress function', async () => {
    const calls: unknown[][] = [];
    mount({
      ...dataSourceOf(baseManifest),
      queryLogs: (...args) => {
        calls.push(args);
        return Promise.resolve(emptyLogResult());
      },
    });
    await screen.findByRole('heading', { name: 'No logs match' });
    const [q, signal] = calls[0] as [LogQuery, unknown];
    expect(q).toMatchObject({ needs: ['rows'], limit: 200, mode: 'logs' });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]).toHaveLength(2);
  });

  test('a failing query shows the error, in either view', async () => {
    const failing = {
      ...dataSourceOf(baseManifest),
      queryLogs: () => Promise.reject(new Error('chunk 3 is corrupt')),
    };
    mount(failing);
    expect((await screen.findByRole('alert')).textContent).toContain('chunk 3 is corrupt');
    cleanup();
    mount(failing, { logView: 'context' });
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('chunk 3 is corrupt');
  });

  test('the matches query failing alone is still reported in Show context', async () => {
    const real = await linked();
    mount(
      {
        ...real,
        queryLogs: (q, s) =>
          q.text === '' && q.condition === null
            ? real.queryLogs(q, s)
            : Promise.reject(new Error('matches broke')),
      },
      { logView: 'context', scope: { condition: 'severity_number >= 1' } },
    );
    expect((await screen.findByRole('alert')).textContent).toContain('matches broke');
  });

  test('the subtitle counts, pluralised, and says "in selected time" for a following window', async () => {
    const ds = await linked();
    const first = mount(ds, { scope: { narrowed: true } });
    await waitFor(() => expect(first.setSubtitle).toHaveBeenCalledWith('2 logs in selected time'));
    cleanup();
    const second = mount(ds, { scope: { condition: 'trace_id.string != ""' } });
    await waitFor(() => expect(second.setSubtitle).toHaveBeenCalledWith('1 log'));
  });

  test('the scope condition filters the rows: only the web log matches a web condition', async () => {
    const ds = await linked();
    const actions = mount(ds, { scope: { condition: 'resource.attributes["service.name"] == "web"' } });
    await waitFor(() => expect(actions.setSubtitle).toHaveBeenCalledWith('1 log'));
    expect(screen.getByText('web log')).toBeTruthy();
    expect(screen.queryByText('charge declined')).toBeNull();
  });

  test('a condition that does not compile fails the query', async () => {
    mount(await linked(), { scope: { condition: 'severity_number >=' } });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
