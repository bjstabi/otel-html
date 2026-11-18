import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string }): React.JSX.Element => <div role="img" aria-label={p.ariaLabel} />,
}));

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { resolveConfig } from '../../src/config/resolve.js';
import { conditionId, widgetTraceConditions } from '../../src/config/widget-traces.js';
import { andConditions } from '../../src/dashboards/conditions.js';
import { DashboardSchema } from '../../src/dashboards/schema.js';
import type { TraceId } from '../../src/model/ids.js';
import type { WidgetActions } from '../../src/viewer/dashboards/dashboard-page.js';
import { scopeFor, type VariableBinding, type WidgetScope } from '../../src/viewer/dashboards/scope.js';
import { TracesWidget } from '../../src/viewer/dashboards/widgets/traces.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { SpanQuery, SpanQueryResult } from '../../src/viewer/data/results.js';
import { EMPTY_DASHBOARD_STATE } from '../../src/viewer/state/dashboard-state.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { baseManifest, currentD, dataSourceOf, emptySpanResult, renderShell } from './dashboard-shell.js';
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

  test('the trace rows load their "Latency by service" share from the data source', async () => {
    const serviceShare = vi.fn(() => Promise.resolve([{ service: 'web', ns: 70 }]));
    renderShell('#/dashboards/fusion', fusionSource({ serviceShare }));
    const traces = await waitFor(() => {
      const r = region('Traces');
      expect(r.getAllByRole('row').length).toBeGreaterThan(1);
      return r;
    });
    expect(await traces.findByRole('img', { name: 'web 70 ns' })).toBeTruthy();
    expect(serviceShare).toHaveBeenCalledWith(LINKED_TRACE, expect.any(AbortSignal));
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
    setVariable: vi.fn(),
    setControls: vi.fn(),
  };
}

const SCOPE: WidgetScope = {
  window: null,
  narrowed: false,
  band: null,
  traceFilter: null,
  vars: [],
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
          controls={null}
          state={EMPTY_DASHBOARD_STATE}
        />
      </SelectionProvider>
    </ThemeProvider>,
  );
  return actions;
}

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

  test('asks for the rows only, limit 200, with a signal and no progress function', async () => {
    const calls: unknown[][] = [];
    mount({
      ...dataSourceOf(baseManifest),
      querySpans: (...args) => {
        calls.push(args);
        return Promise.resolve(emptySpanResult());
      },
    });
    await screen.findByRole('heading', { name: 'No traces match' });
    const [q, signal] = calls[0] as [SpanQuery, unknown];
    expect(q).toMatchObject({ needs: ['rows'], limit: 200, mode: 'traces' });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]).toHaveLength(2);
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
      querySpans: (q, signal) =>
        q.sort.dir === 'asc'
          ? new Promise<SpanQueryResult>((resolve) => {
              release = () => resolve(emptySpanResult());
            })
          : real.querySpans(q, signal),
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

  test('the scope condition filters the spans: one span matches a name condition', async () => {
    const actions = mount(await linked(), {
      over: { mode: 'spans' },
      scope: { condition: 'name == "charge"' },
    });
    await waitFor(() => expect(actions.setSubtitle).toHaveBeenCalledWith('1 span'));
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + the one span
  });
});

describe('the Traces widget names its indexed condition', () => {
  const QUERY = 'IsRootSpan() and attributes["x"] != nil';
  const JOB: VariableBinding = { key: 'job', value: 'build', kind: 'string' };

  async function sent(over: object, vars: readonly VariableBinding[], sel = false): Promise<SpanQuery> {
    const { w } = widgetOf(over);
    const scope = scopeFor(w, {
      page: null,
      sel: { t: sel ? { start: 10, end: 20 } : null, trace: null },
      following: sel,
      vars,
    });
    const calls: SpanQuery[] = [];
    mount(
      {
        ...dataSourceOf(baseManifest),
        querySpans: (q) => {
          calls.push(q);
          return Promise.resolve(emptySpanResult());
        },
      },
      { over, scope },
    );
    await screen.findByRole('heading', { name: 'No traces match' });
    const q = calls[0];
    if (q === undefined) throw new Error('no query');
    return q;
  }

  test('no variables: the hint is the widget query and no variable condition', async () => {
    const q = await sent({ query: QUERY }, []);
    expect(q.widgetIndex).toEqual({ query: QUERY, variables: null, bindings: [] });
    expect(q.condition).toBe(andConditions(QUERY, null));
  });

  test('a bound job: the hint carries the variable condition and the binding', async () => {
    const q = await sent({ query: QUERY }, [JOB]);
    expect(q.widgetIndex).toEqual({
      query: QUERY,
      variables: 'resource.attributes["job"] == "build"',
      bindings: [{ key: 'job', value: 'build' }],
    });
  });

  test('a widget text, no query or an int binding sends no hint', async () => {
    expect((await sent({ query: QUERY, text: 'boom' }, [])).widgetIndex).toBeUndefined();
    cleanup();
    expect((await sent({}, [])).widgetIndex).toBeUndefined();
    cleanup();
    expect(
      (await sent({ query: QUERY }, [{ key: 'n', value: '3', kind: 'int' }])).widgetIndex,
    ).toBeUndefined();
  });

  test('a following widget with a selection still sends the hint', async () => {
    const q = await sent({ query: QUERY }, [JOB], true);
    expect(q.widgetIndex?.query).toBe(QUERY);
    expect(q.window).not.toBeNull();
  });
});

describe('the CI Runs widget and the writer agree on the condition', () => {
  const file = 'test-support/legacy-ci.otel-html.yaml';
  const { config } = resolveConfig({
    file: parse(readFileSync(file, 'utf8')),
    env: {},
    fileLabel: file,
  });
  const dash = config.dashboards.find((d) => d.dashboard.id === 'ci');
  const runs = dash?.dashboard.widgets.find((x) => x.type === 'traces' && x.title === 'Runs');
  const JOB: VariableBinding = { key: 'job', value: 'unit', kind: 'string' };
  const WORKFLOW: VariableBinding = { key: 'workflow', value: 'ci', kind: 'string' };

  test.each([
    ['no variables', []],
    ['job bound', [JOB]],
    ['job and workflow bound', [JOB, WORKFLOW]],
  ])("%s: q.condition is the hint joined, and the id is the writer's", async (_name, vars) => {
    if (runs?.type !== 'traces' || dash === undefined) throw new Error('no Runs widget');
    const scope = scopeFor(runs, { page: null, sel: { t: null, trace: null }, following: false, vars });
    const calls: SpanQuery[] = [];
    render(
      <ThemeProvider>
        <SelectionProvider store={createSelectionStore({})}>
          <TracesWidget
            widget={runs}
            scope={scope}
            dashboard={{ dashboard: dash.dashboard, source: 'x', isDefault: false }}
            height={400}
            dataSource={{
              ...dataSourceOf(baseManifest),
              querySpans: (q) => {
                calls.push(q);
                return Promise.resolve(emptySpanResult());
              },
            }}
            actions={actionsOf()}
            variables={[]}
            controls={null}
            state={EMPTY_DASHBOARD_STATE}
          />
        </SelectionProvider>
      </ThemeProvider>,
    );
    await screen.findByRole('heading', { name: 'No traces match' });
    const q = calls[0];
    const hint = q?.widgetIndex;
    if (q === undefined || hint === undefined) throw new Error('no hint');
    expect(q.condition).toBe(andConditions(hint.query, hint.variables));
    expect(q.text).toBe('');
    expect(hint.bindings.map((b) => b.key)).toEqual(vars.map((b) => b.key));
    const written = widgetTraceConditions(config.dashboards).conditions.map((c) => c.id);
    expect(written).toContain(conditionId(hint.query));
  });
});
