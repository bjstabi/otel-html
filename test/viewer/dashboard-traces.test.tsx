import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';

vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string }): React.JSX.Element => <div role="img" aria-label={p.ariaLabel} />,
}));

import { DashboardSchema } from '../../src/dashboards/schema.js';
import type { TraceId } from '../../src/model/ids.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { RedSeries } from '../../src/rollups/red.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import type { WidgetActions } from '../../src/viewer/dashboards/dashboard-page.js';
import type { WidgetScope } from '../../src/viewer/dashboards/scope.js';
import { TracesWidget } from '../../src/viewer/dashboards/widgets/traces.js';
import {
  createDataSource,
  type DataSource,
  type SpanQueryResult,
} from '../../src/viewer/data/data-source.js';
import { EMPTY_DASHBOARD_STATE } from '../../src/viewer/state/dashboard-state.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { baseManifest, currentD, dataSourceOf, renderShell } from './dashboard-shell.js';
import { buildEmbeddedMetricsReport, LINKED_TRACE } from './report-fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

async function linked(): Promise<DataSource> {
  const report = await buildEmbeddedMetricsReport();
  return createDataSource(createScriptedLoader(report.files), report.manifest, 1);
}

/** The widget frame by its id (the sidebar has regions with the same names). */
function regionEl(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-widget="${name.toLowerCase()}"]`);
  if (el === null) throw new Error(`no ${name} widget`);
  return el;
}
const region = (name: string) => within(regionEl(name));

async function tracesWidget() {
  renderShell('#/dashboards/fusion', await linked());
  const traces = await waitFor(() => {
    const r = region('Traces');
    expect(r.getAllByRole('row').length).toBeGreaterThan(1);
    return r;
  });
  return traces;
}

describe('the Traces widget', () => {
  test('lists the report traces, says how many, and shows no flame graph until one is selected', async () => {
    const traces = await tracesWidget();
    expect(traces.getAllByRole('row')).toHaveLength(2); // header + the one linked trace
    await waitFor(() => expect(regionEl('Traces').textContent).toContain('1 trace'));
    expect(traces.queryByTestId('flame-graph')).toBeNull();
  });

  test('a row click sets d.sel.trace and renders a compact flame graph without minimap, legend or color-by', async () => {
    const user = userEvent.setup();
    const traces = await tracesWidget();
    const row = traces.getAllByRole('row')[1];
    if (row === undefined) throw new Error('no row');
    await user.click(row);
    await waitFor(() => expect(currentD()?.sel.trace).toBe(LINKED_TRACE));
    await waitFor(() => expect(traces.getByTestId('flame-graph')).toBeTruthy());
    expect(traces.queryByLabelText('Color by')).toBeNull();
    expect(traces.queryByRole('heading', { name: /Share of exclusive execution time/ })).toBeNull();
  });

  test('"open trace panel" opens the trace panel through the selection store', async () => {
    const user = userEvent.setup();
    const traces = await tracesWidget();
    const row = traces.getAllByRole('row')[1];
    if (row === undefined) throw new Error('no row');
    await user.click(row);
    await user.click(await traces.findByRole('button', { name: /open trace panel/ }));
    await waitFor(() => expect(parseUrlState(window.location.hash).state.trace).toBe(LINKED_TRACE));
    expect(await screen.findByTestId('trace-panel')).toBeTruthy();
  });

  test('with the follow toggle off the selected trace is not highlighted and the flame graph is gone', async () => {
    const user = userEvent.setup();
    const traces = await tracesWidget();
    const row = traces.getAllByRole('row')[1];
    if (row === undefined) throw new Error('no row');
    await user.click(row);
    await traces.findByTestId('flame-graph');
    await user.click(traces.getByRole('button', { name: /follows selection/ }));
    await waitFor(() => expect(traces.queryByTestId('flame-graph')).toBeNull());
  });

  test('Open in Traces carries the window, the query, and the mode', async () => {
    const user = userEvent.setup();
    const traces = await tracesWidget();
    await user.click(traces.getByRole('button', { name: /Open in Traces/ }));
    await waitFor(() => expect(window.location.hash.startsWith('#/traces')).toBe(true));
    // Fusion's Traces widget is in traces mode, which is not the Traces page's default (spans).
    const url = parseUrlState(window.location.hash).state;
    expect(url.mode).toBe('traces');
    expect(url.q).toBeUndefined(); // Fusion's Traces widget has no query and no variable is bound
    expect(url.text).toBeUndefined();
    expect(url.t).toBeUndefined(); // the page shows the entire run
  });
});

const widgetOf = (over: object = {}) => {
  const dashboard = DashboardSchema.parse({
    id: 'd',
    title: 'D',
    widgets: [{ type: 'traces', x: 0, y: 0, w: 7, h: 13, ...over }],
  });
  const w = dashboard.widgets[0];
  if (w === undefined) throw new Error('no widget');
  return { dashboard, w };
};

function actionsOf(): WidgetActions {
  return {
    selectWindow: vi.fn(),
    selectTrace: vi.fn(),
    openIn: vi.fn(),
    setLogView: vi.fn(),
    setSubtitle: vi.fn(),
  };
}

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
  opts: { over?: object; scope?: Partial<WidgetScope>; actions?: WidgetActions } = {},
): WidgetActions {
  const { dashboard, w } = widgetOf(opts.over);
  const actions = opts.actions ?? actionsOf();
  render(
    <ThemeProvider>
      <SelectionProvider store={createSelectionStore({})}>
        <TracesWidget
          widget={w}
          scope={{ ...SCOPE, ...opts.scope }}
          dashboard={{ dashboard, source: 'x', isDefault: false }}
          height={400}
          dataSource={ds}
          actions={actions}
          variables={[]}
          state={EMPTY_DASHBOARD_STATE}
        />
      </SelectionProvider>
    </ThemeProvider>,
  );
  return actions;
}

const emptySpans = (partial: SpanQueryResult['partial'] = null): SpanQueryResult => ({
  rows: [],
  total: 0,
  facets: new FacetCounts(10, 10),
  buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
  red: new RedSeries(8),
  partial,
});

describe('the Traces widget states', () => {
  test('loading shows a status and no rows', () => {
    mount({ ...dataSourceOf(baseManifest), querySpans: () => new Promise<SpanQueryResult>(() => {}) });
    expect(screen.getByRole('status').textContent).toBe('Loading');
    expect(screen.queryByRole('grid')).toBeNull();
  });

  test('an empty result says no traces match', async () => {
    mount(dataSourceOf(baseManifest));
    expect((await screen.findByRole('heading', { name: 'No traces match' })).tagName).toBe('H3');
  });

  test('a partial scan says how much was read and Scan entire run rereads everything', async () => {
    const calls: boolean[] = [];
    mount({
      ...dataSourceOf(baseManifest),
      querySpans: (q) => {
        calls.push(q.scanAll);
        return Promise.resolve(emptySpans(q.scanAll ? null : { scanned: 2, total: 5 }));
      },
    });
    expect(await screen.findByText(/from 2 of 5 chunks/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Scan entire run' }));
    await waitFor(() => expect(screen.queryByText(/from 2 of 5 chunks/)).toBeNull());
    expect(calls).toEqual([false, true]);
  });

  test('a failing query shows the error', async () => {
    mount({
      ...dataSourceOf(baseManifest),
      querySpans: () => Promise.reject(new Error('chunk 3 is corrupt')),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('chunk 3 is corrupt');
  });

  test('rows of the previous inputs are not shown while the new query runs', async () => {
    const real = await linked();
    let release: (() => void) | null = null;
    const ds: DataSource = {
      ...real,
      querySpans: (q, onProgress, signal) =>
        q.sort.dir === 'asc'
          ? new Promise<SpanQueryResult>((resolve) => {
              release = () => resolve(emptySpans());
            })
          : real.querySpans(q, onProgress, signal),
    };
    mount(ds);
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole('button', { name: /Time/ })); // desc -> asc: a new query
    await waitFor(() => expect(screen.queryByRole('grid')).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('Loading');
    expect(release).not.toBeNull();
  });

  test('"N traces in selected time" follows a selection window; otherwise the count is pluralised', async () => {
    const ds = await linked();
    const first = mount(ds, { scope: { narrowed: true } });
    await waitFor(() => expect(first.setSubtitle).toHaveBeenCalledWith('1 trace in selected time'));
    cleanup();
    const second = mount(ds);
    await waitFor(() => expect(second.setSubtitle).toHaveBeenCalledWith('1 trace'));
  });
});

describe('the Traces widget in spans mode', () => {
  test("a span row click selects that span's trace, and the followed trace's row is marked", async () => {
    const ds = await linked();
    const actions = mount(ds, {
      over: { mode: 'spans' },
      scope: { highlightTrace: LINKED_TRACE as TraceId },
    });
    await waitFor(() => expect(screen.getAllByRole('row').length).toBe(3)); // header + two spans
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.some((r) => r.getAttribute('data-selected') === 'true')).toBe(true);
    const row = rows[0];
    if (row === undefined) throw new Error('no row');
    fireEvent.click(row);
    expect(actions.selectTrace).toHaveBeenCalledWith(LINKED_TRACE);
    await waitFor(() => expect(actions.setSubtitle).toHaveBeenCalledWith('2 spans'));
  });
});
