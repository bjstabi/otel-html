import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const charts = vi.hoisted(
  (): { label: string; option: unknown; onEvents: { click?: (e: unknown) => void } | undefined }[] => [],
);
vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: {
    option: unknown;
    ariaLabel: string;
    onEvents?: { click?: (e: unknown) => void };
  }): React.JSX.Element => {
    charts.push({ label: p.ariaLabel, option: p.option, onEvents: p.onEvents });
    return <div role="img" aria-label={p.ariaLabel} />;
  },
}));

const runs = vi.hoisted((): { queries: { id: string; where: string | null }[] }[] => []);
vi.mock('../../src/viewer/metrics/use-metric-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/viewer/metrics/use-metric-query.js')>();
  return {
    ...actual,
    useMetricQueries: (...args: Parameters<typeof actual.useMetricQueries>) => {
      runs.push(args[1]);
      return actual.useMetricQueries(...args);
    },
  };
});

const runQueries = vi.hoisted(
  (): { where: string | null; window: { start: number; end: number }; runBy: string }[] => [],
);
vi.mock('../../src/viewer/data/metric-run-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/viewer/data/metric-run-query.js')>();
  return {
    ...actual,
    runMetricRunQuery: (...args: Parameters<typeof actual.runMetricRunQuery>) => {
      runQueries.push({ where: args[1].where, window: args[2].window, runBy: args[2].runBy });
      return actual.runMetricRunQuery(...args);
    },
  };
});

import { type Dashboard, DashboardSchema, type RunControls } from '../../src/dashboards/schema.js';
import type { Manifest } from '../../src/format/manifest.js';
import type { AnyValue } from '../../src/model/anyvalue.js';
import { parseTraceId } from '../../src/model/ids.js';
import type { ResourceRecord } from '../../src/model/records.js';
import type { WidgetActions } from '../../src/viewer/dashboards/dashboard-page.js';
import type { VariableBinding, WidgetScope } from '../../src/viewer/dashboards/scope.js';
import { MetricWidget } from '../../src/viewer/dashboards/widgets/metric.js';
import { createDataSource, type DataSource } from '../../src/viewer/data/data-source.js';
import { GoToContext } from '../../src/viewer/shell/go-to.js';
import { EMPTY_DASHBOARD_STATE } from '../../src/viewer/state/dashboard-state.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';
import { currentD, renderShell } from './dashboard-shell.js';
import { buildEmbeddedMetricsReport, type Fixture, LINKED_TRACE } from './report-fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let report: Fixture;
beforeAll(async () => {
  report = await buildEmbeddedMetricsReport();
});
beforeEach(() => {
  window.location.hash = '';
  charts.length = 0;
  runs.length = 0;
  runQueries.length = 0;
});
afterEach(cleanup);

const S = 1_000_000_000;
const TRACE = parseTraceId(LINKED_TRACE, 'LINKED_TRACE');

async function linked(manifest: Manifest = report.manifest): Promise<DataSource> {
  return createDataSource(createScriptedLoader(report.files), manifest, 1);
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

const CPU = { id: 'a', metric: 'process.cpu.utilization', show: 'avg' };

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

interface Mounted {
  actions: WidgetActions;
  update(next: { scope?: Partial<WidgetScope>; ds?: DataSource }): void;
}

function mount(
  ds: DataSource,
  over: {
    widget?: object;
    scope?: Partial<WidgetScope>;
    variables?: readonly VariableBinding[];
    /** The dashboard's configured variables, unlike `variables`: the bound values. */
    configured?: readonly string[];
    controls?: RunControls | null;
  } = {},
): Mounted {
  const dashboard = DashboardSchema.parse({
    id: 'd',
    title: 'D',
    variables: over.configured ?? [],
    widgets: [{ type: 'metric', x: 0, y: 0, w: 12, h: 12, queries: [CPU], ...over.widget }],
  });
  const w = dashboard.widgets[0];
  if (w === undefined) throw new Error('no widget');
  const actions = actionsOf();
  const tree = (source: DataSource, scope: Partial<WidgetScope>): React.JSX.Element => (
    <ThemeProvider>
      <GoToContext.Provider value={vi.fn()}>
        <SelectionProvider store={createSelectionStore({})}>
          <MetricWidget
            widget={w}
            scope={{ ...SCOPE, ...scope }}
            dashboard={{ dashboard, source: 'x', isDefault: false }}
            height={500}
            dataSource={source}
            actions={actions}
            variables={over.variables ?? []}
            controls={over.controls ?? null}
            state={EMPTY_DASHBOARD_STATE}
          />
        </SelectionProvider>
      </GoToContext.Provider>
    </ThemeProvider>
  );
  const { rerender } = render(tree(ds, over.scope ?? {}));
  return { actions, update: (n) => rerender(tree(n.ds ?? ds, n.scope ?? over.scope ?? {})) };
}

/**
 * `ds` with the trace's resources mapped through `trace` and the catalog's resources replaced by `catalog(all)`; the
 * catalog is a proxy, so everything else (and its private state) is the real one.
 */
async function withResources(
  ds: DataSource,
  trace: (r: ResourceRecord) => ResourceRecord,
  catalog: (all: readonly ResourceRecord[]) => ResourceRecord[],
): Promise<DataSource> {
  const real = await ds.metricCatalog();
  const resources = catalog(real.resources());
  const proxied = new Proxy(real, {
    get(target, key) {
      if (key === 'resources') return () => resources;
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return {
    ...ds,
    metricCatalog: () => Promise.resolve(proxied),
    getTrace: async (id) => {
      const d = await ds.getTrace(id);
      return { ...d, resources: (ref) => trace(d.resources(ref)) };
    },
  };
}

const SERVICE = 'resource.attributes["service.name"]';
const lastRun = (): { id: string; where: string | null }[] => runs.at(-1)?.queries ?? [];

describe('the Metrics widget with queries', () => {
  test('draws one chart for one query', async () => {
    mount(await linked());
    expect(await screen.findByRole('img', { name: /process\.cpu\.utilization/ })).toBeTruthy();
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  test('the variables are folded into each query where', async () => {
    mount(await linked(), {
      widget: {
        queries: [
          { ...CPU, where: 'attributes["x"] == 1' },
          { ...CPU, id: 'b' },
        ],
      },
      variables: [{ key: 'service.name', value: 'payments', kind: 'string' }],
    });
    await waitFor(() => expect(lastRun().length).toBe(2));
    const [a, b] = lastRun();
    expect(a?.where).toBe(`(attributes["x"] == 1) and (${SERVICE} == "payments")`);
    expect(b?.where).toBe(`${SERVICE} == "payments"`);
  });

  test('a followed trace adds its resources to the where, once they are read, and highlights its exemplars', async () => {
    mount(await linked(), { scope: { highlightTrace: TRACE }, widget: { exemplars: true } });
    await screen.findByRole('img', { name: /process\.cpu\.utilization/ });
    const where = lastRun()[0]?.where ?? '';
    expect(where).toContain(`${SERVICE} == "checkout"`);
    expect(where).toContain(`${SERVICE} == "payments"`);
    expect(where).not.toContain('"web"');
    // Nothing ran on the wider set while the trace was being read.
    expect(runs.some((r) => r.queries.length > 0 && !(r.queries[0]?.where ?? '').includes(SERVICE))).toBe(
      false,
    );
  });

  test('a followed trace whose resources a filter cannot fully tell apart says so beside the charts', async () => {
    // The trace's resources get an array attribute; the catalog gains a lookalike that differs only in its value,
    // which no `where` can compare: the charts include it, and the widget says so.
    const tags = (v: string): AnyValue => ({ kind: 'array', values: [{ kind: 'string', value: v }] });
    const tagged = (r: ResourceRecord, v: string): ResourceRecord => ({
      ...r,
      attributes: new Map([...r.attributes, ['tags', tags(v)]]),
    });
    const ds = await withResources(
      await linked(),
      (r) => tagged(r, 'a'),
      (all) => [...all.map((r) => tagged(r, 'a')), ...all.slice(0, 1).map((r) => tagged(r, 'b'))],
    );
    mount(ds, { scope: { highlightTrace: TRACE } });
    await screen.findByRole('img', { name: /process\.cpu\.utilization/ });
    expect(screen.getByRole('note').textContent).toMatch(/also include 1 other resource /);
  });

  test('a followed trace whose resources have no attribute to filter on says the charts show every resource', async () => {
    const bare = (r: ResourceRecord): ResourceRecord => ({
      ...r,
      attributes: new Map([['tags', { kind: 'array', values: [] } as AnyValue]]),
    });
    mount(await withResources(await linked(), bare, (all) => all.map(bare)), {
      scope: { highlightTrace: TRACE },
    });
    await screen.findByRole('img', { name: /process\.cpu\.utilization/ });
    expect(screen.getByRole('note').textContent).toMatch(/show every resource/);
    expect(lastRun()[0]?.where ?? null).toBeNull();
  });

  test('the selection band, the echarts override and the scale reach the chart option', async () => {
    mount(await linked(), {
      scope: { band: { start: 10 * S, end: 20 * S } },
      widget: { echarts: { grid: { top: 77 } }, scale: 'log' },
    });
    await screen.findByRole('img');
    const option = charts.at(-1)?.option as {
      grid: { top: number };
      yAxis: { type: string };
      series: { markArea?: { data: { xAxis: number }[][] } }[];
    };
    expect(option.grid.top).toBe(77);
    expect(option.yAxis.type).toBe('log');
    expect(option.series.find((s) => s.markArea !== undefined)?.markArea?.data).toEqual([
      [{ xAxis: 10 * S }, { xAxis: 20 * S }],
    ]);
  });

  test('a metric the report lacks is the empty state, naming it', async () => {
    mount(await linked(), { widget: { queries: [{ id: 'a', metric: 'nope.nothing', show: 'avg' }] } });
    expect(await screen.findByText('nope.nothing is not in this report')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('two queries on the same missing metric are the empty state too', async () => {
    mount(await linked(), {
      widget: {
        queries: [
          { id: 'a', metric: 'nope.nothing', show: 'avg' },
          { id: 'b', metric: 'nope.nothing', show: 'max' },
        ],
      },
    });
    expect(await screen.findByText('Not in this report')).toBeTruthy();
    expect(screen.getByText('nope.nothing is not in this report')).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });

  test('two missing metrics are named together', async () => {
    mount(await linked(), {
      widget: {
        queries: [
          { id: 'a', metric: 'nope.one', show: 'avg' },
          { id: 'b', metric: 'nope.two', show: 'avg' },
        ],
      },
    });
    expect(await screen.findByText('nope.one, nope.two are not in this report')).toBeTruthy();
  });

  test('one missing metric is a note beside the other queries chart', async () => {
    mount(await linked(), {
      widget: { queries: [CPU, { id: 'b', metric: 'nope.nothing', show: 'avg' }] },
    });
    expect(await screen.findByRole('img', { name: /process\.cpu\.utilization/ })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe('nope.nothing is not in this report');
  });

  test('loading shows a status and no chart', async () => {
    const real = await linked();
    mount({ ...real, metric: () => new Promise(() => {}) });
    expect((await screen.findByRole('status')).textContent).toBe('Loading');
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('a metric that fails to load is an error inside the widget', async () => {
    const real = await linked();
    mount({ ...real, metric: () => Promise.reject(new Error('chunk 3 is corrupt')) });
    expect((await screen.findByRole('alert')).textContent).toContain('chunk 3 is corrupt');
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('a catalog that fails to load is an error', async () => {
    const real = await linked();
    mount({ ...real, metricCatalog: () => Promise.reject(new Error('catalog broke')) });
    expect((await screen.findByRole('alert')).textContent).toContain('catalog broke');
  });

  test('a trace that cannot be read is an error, not the wider set', async () => {
    const real = await linked();
    mount(
      { ...real, getTrace: () => Promise.reject(new Error('shard missing')) },
      { scope: { highlightTrace: TRACE } },
    );
    expect((await screen.findByRole('alert')).textContent).toContain('shard missing');
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('a window with no data points says so', async () => {
    mount(await linked(), { scope: { window: { start: 5000 * S, end: 6000 * S } } });
    expect(await screen.findByText('No data points in this window')).toBeTruthy();
  });

  test('the previous result is not shown as current while a changed window loads', async () => {
    const real = await linked();
    let hang = false;
    const ds: DataSource = {
      ...real,
      metric: (id) => (hang ? new Promise(() => {}) : real.metric(id)),
    };
    const m = mount(ds);
    await screen.findByRole('img');
    hang = true;
    m.update({ scope: { window: { start: 0, end: 60 * S } } });
    await waitFor(() => expect(screen.queryByRole('img')).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('Loading');
  });

  test('metric data is read whole, so there is no chunk scan to be partial about', async () => {
    mount(await linked());
    await screen.findByRole('img');
    expect(screen.queryByText(/chunks/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Scan entire run' })).toBeNull();
  });
});

describe('the Metrics widget without queries', () => {
  function gridPage(): { lookups: number[] } {
    return { lookups: [] };
  }

  async function fusion(): Promise<{ ds: DataSource; seen: ReturnType<typeof gridPage> }> {
    const real = await linked();
    const seen = gridPage();
    const ds: DataSource = {
      ...real,
      metricsForResources: (rs) => {
        seen.lookups.push(rs.length);
        return real.metricsForResources(rs);
      },
    };
    return { ds, seen };
  }

  const metricsRegion = () =>
    within(screen.getByTestId('metric-grid').closest<HTMLElement>('[data-widget]') ?? document.body);

  test('with no selection it lists the catalog namespaces over every resource', async () => {
    const { ds, seen } = await fusion();
    renderShell('#/dashboards/fusion', ds);
    const grid = await screen.findByTestId('metric-grid');
    expect(await within(grid).findByRole('button', { name: /^process/ })).toBeTruthy();
    expect(within(grid).getByRole('button', { name: /^http/ })).toBeTruthy();
    expect(within(grid).queryByText('± 5 min')).toBeNull();
    expect(metricsRegion().getByText('all resources')).toBeTruthy();
    // checkout, payments, payments + process.pid: more than the trace's two.
    expect(Math.max(...seen.lookups)).toBe(3);
  });

  test('after selecting a trace it narrows to that trace resources', async () => {
    const user = userEvent.setup();
    const { ds, seen } = await fusion();
    renderShell('#/dashboards/fusion', ds);
    await screen.findByTestId('metric-grid');
    const traces = document.querySelector<HTMLElement>('[data-widget="traces"]');
    if (traces === null) throw new Error('no traces widget');
    const row = await waitFor(() => {
      const r = within(traces).getAllByRole('row')[1];
      if (r === undefined) throw new Error('no row');
      return r;
    });
    seen.lookups.length = 0;
    await user.click(row);
    await waitFor(() => expect(currentD()?.sel.trace).toBe(LINKED_TRACE));
    await waitFor(() =>
      expect(metricsRegion().getByText("from the selected trace's resources")).toBeTruthy(),
    );
    await waitFor(() => expect(seen.lookups.at(-1)).toBe(2));
  });

  test('the variables narrow the grid resources and the subtitle says so', async () => {
    const { ds, seen } = await fusion();
    const { actions } = mount(ds, {
      widget: { queries: null },
      variables: [{ key: 'service.name', value: 'checkout', kind: 'string' }],
    });
    await screen.findByTestId('metric-grid');
    await waitFor(() => expect(seen.lookups.length).toBeGreaterThan(0));
    expect(Math.max(...seen.lookups)).toBe(1);
    expect(actions.setSubtitle).toHaveBeenCalledWith('all resources, where service.name = checkout');
  });

  test('variables matching no resource say so', async () => {
    const { ds } = await fusion();
    mount(ds, {
      widget: { queries: null },
      variables: [{ key: 'service.name', value: 'nope', kind: 'string' }],
    });
    expect(await screen.findByText('No matching resources')).toBeTruthy();
  });

  test('the grid body scrolls inside the widget height', async () => {
    renderShell('#/dashboards/fusion', await linked());
    const grid = await screen.findByTestId('metric-grid');
    expect(grid.parentElement?.className).toContain('overflow-auto');
  });

  test('an error reading the trace is shown in the widget', async () => {
    const real = await linked();
    mount(
      { ...real, getTrace: () => Promise.reject(new Error('shard missing')) },
      {
        widget: { queries: null },
        scope: { highlightTrace: TRACE },
      },
    );
    expect((await screen.findByRole('alert')).textContent).toContain('shard missing');
  });

  test('loading the catalog shows a status', async () => {
    const real = await linked();
    mount({ ...real, metricCatalog: () => new Promise(() => {}) }, { widget: { queries: null } });
    expect((await screen.findByRole('status')).textContent).toBe('Loading');
  });

  test('a report with no metrics says so', async () => {
    const real = await linked();
    mount({ ...real, manifest: { ...real.manifest, range: null } }, { widget: { queries: null } });
    expect(await screen.findByText('This report has no metrics')).toBeTruthy();
  });
});

describe('the Metrics widget with runBy', () => {
  const RUN_BY = { runBy: SERVICE };
  const SERVICES = ['service.name'];

  interface Option {
    backgroundColor?: string;
    series: { id: string; cursor?: string; markLine?: { data: { xAxis: number }[] } }[];
  }
  const lastOption = (): Option => charts.at(-1)?.option as Option;
  const guideX = (): number | undefined =>
    lastOption().series.find((s) => s.id.startsWith('guide'))?.markLine?.data[0]?.xAxis;
  const lineCursor = (): string | undefined =>
    lastOption().series.find((s) => s.id.startsWith('line:'))?.cursor;
  const clickDot = (run: string): void => {
    act(() => charts.at(-1)?.onEvents?.click?.({ data: { meta: { run: { id: run } } } }));
  };
  const toggle = (name: string): HTMLElement => screen.getByRole('button', { name });

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  test('draws the run chart card, and a widget without runBy still draws the bucket chart', async () => {
    mount(await linked(), { widget: RUN_BY });
    expect(
      await screen.findByRole('img', { name: /process\.cpu\.utilization.*lines over \d+ runs/ }),
    ).toBeTruthy();
    expect(toggle('Slider')).toBeTruthy();
    expect(runs.every((r) => r.queries.length === 0)).toBe(true);
    cleanup();
    runQueries.length = 0;
    mount(await linked());
    await screen.findByRole('img', { name: /process\.cpu\.utilization/ });
    expect(screen.queryByRole('button', { name: 'Slider' })).toBeNull();
    expect(runQueries).toEqual([]);
  });

  test('the query covers the scope window, else the whole run', async () => {
    const ds = await linked();
    mount(ds, { widget: RUN_BY, scope: { window: { start: 0, end: 5000 * S } } });
    await screen.findByRole('img');
    expect(runQueries.at(-1)?.window).toEqual({ start: 0, end: 5000 * S });
    expect(runQueries.at(-1)?.runBy).toBe(SERVICE);
    cleanup();
    mount(ds, { widget: RUN_BY });
    await screen.findByRole('img');
    expect(runQueries.at(-1)?.window).toEqual(ds.manifest.range);
  });

  test('a binding on its own runBy key is not in the where and draws the guide; other bindings narrow it', async () => {
    mount(await linked(), {
      widget: { ...RUN_BY, queries: [{ ...CPU, where: 'attributes["x"] != 1' }] },
      variables: [
        { key: 'service.name', value: 'checkout', kind: 'string' },
        { key: 'host.name', value: 'runner-1', kind: 'string' },
      ],
    });
    await screen.findByRole('img');
    const where = runQueries.at(-1)?.where ?? '';
    expect(where).toContain('attributes["x"] != 1');
    expect(where).toContain('resource.attributes["host.name"] == "runner-1"');
    expect(where).not.toContain('service.name');
    expect(guideX()).toBeDefined();
  });

  test('without a binding on its key there is no guide', async () => {
    mount(await linked(), {
      widget: RUN_BY,
      variables: [{ key: 'host.name', value: 'runner-1', kind: 'string' }],
    });
    await screen.findByRole('img');
    expect(guideX()).toBeUndefined();
  });

  test('a followed trace narrows it, once its resources are read', async () => {
    mount(await linked(), { widget: RUN_BY, scope: { highlightTrace: TRACE } });
    await screen.findByRole('img');
    expect(runQueries.every((q) => (q.where ?? '').includes('"checkout"'))).toBe(true);
    expect(runQueries.length).toBeGreaterThan(0);
  });

  test('clicking a dot sets the variable named by runBy', async () => {
    const { actions } = mount(await linked(), { widget: RUN_BY, configured: SERVICES });
    await screen.findByRole('img');
    expect(lineCursor()).toBe('pointer');
    clickDot('payments');
    expect(actions.setVariable).toHaveBeenCalledWith('service.name', 'payments');
  });

  test('with no variable of that key a click does nothing and dots have no pointer', async () => {
    const { actions } = mount(await linked(), { widget: RUN_BY, configured: ['host.name'] });
    await screen.findByRole('img');
    expect(lineCursor()).not.toBe('pointer');
    clickDot('payments');
    expect(actions.setVariable).not.toHaveBeenCalled();
  });

  test('a run path that is not a resource attribute narrows as usual and has no click', async () => {
    const { actions } = mount(await linked(), {
      widget: { runBy: 'attributes["cpu"]' },
      configured: SERVICES,
      variables: [{ key: 'service.name', value: 'payments', kind: 'string' }],
    });
    await waitFor(() => expect(runQueries.length).toBeGreaterThan(0));
    expect(runQueries.at(-1)?.where).toContain('service.name');
    clickDot('x');
    expect(actions.setVariable).not.toHaveBeenCalled();
  });

  test('series with no run are left out and counted in a card note', async () => {
    mount(await linked(), { widget: { runBy: 'resource.attributes["process.pid"]' } });
    await screen.findByRole('img');
    const notes = screen.getByRole('list', { name: 'Notes' });
    expect(notes.textContent).toMatch(/\d+ series ha(s|ve) no value for .*process\.pid.* left out/);
  });

  test('toggles read the session value over the config, and a click reports the change', async () => {
    const user = userEvent.setup();
    const session = { slider: false, evenSpacing: true, split: true, legend: false };
    const { actions } = mount(await linked(), {
      widget: { ...RUN_BY, controls: { slider: true } },
      controls: session,
    });
    await screen.findByRole('img');
    expect(toggle('Slider').getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle('Legend'));
    expect(actions.setControls).toHaveBeenCalledWith({ ...session, legend: true });
    // Reset goes back to the config, not to the session's.
    await user.click(toggle('Reset'));
    expect(actions.setControls).toHaveBeenLastCalledWith({ ...session, slider: true });
  });

  test('without a session value the toggles are the config', async () => {
    mount(await linked(), { widget: { ...RUN_BY, controls: { slider: false } } });
    await screen.findByRole('img');
    expect(toggle('Slider').getAttribute('aria-pressed')).toBe('false');
  });

  test('echarts merges last', async () => {
    mount(await linked(), { widget: { ...RUN_BY, echarts: { backgroundColor: '#123456' } } });
    await screen.findByRole('img');
    expect(lastOption().backgroundColor).toBe('#123456');
  });

  test('a page re-render with equal inputs neither re-runs the query nor rebuilds the option', async () => {
    const m = mount(await linked(), {
      widget: RUN_BY,
      scope: { window: { start: 0, end: 5000 * S } },
      variables: [{ key: 'host.name', value: 'runner-1', kind: 'string' }],
    });
    await screen.findByRole('img');
    const option = lastOption();
    const queried = runQueries.length;
    m.update({ scope: { window: { start: 0, end: 5000 * S } } });
    await act(async () => {});
    expect(lastOption()).toBe(option);
    expect(runQueries).toHaveLength(queried);
  });

  test('a metric the report lacks is the empty state, naming it', async () => {
    mount(await linked(), {
      widget: { ...RUN_BY, queries: [{ id: 'a', metric: 'nope.nothing', show: 'avg' }] },
    });
    expect(await screen.findByText('Not in this report')).toBeTruthy();
    expect(screen.getByText('nope.nothing is not in this report')).toBeTruthy();
    expect(runQueries).toEqual([]);
  });

  test('a metric that fails to load is an error inside the widget', async () => {
    const real = await linked();
    mount({ ...real, metric: () => Promise.reject(new Error('chunk 3 is corrupt')) }, { widget: RUN_BY });
    expect((await screen.findByRole('alert')).textContent).toContain('chunk 3 is corrupt');
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('a catalog that fails to load is an error', async () => {
    const real = await linked();
    mount({ ...real, metricCatalog: () => Promise.reject(new Error('catalog broke')) }, { widget: RUN_BY });
    expect((await screen.findByRole('alert')).textContent).toContain('catalog broke');
  });

  test('a trace that cannot be read is an error, not the wider set', async () => {
    const real = await linked();
    mount(
      { ...real, getTrace: () => Promise.reject(new Error('shard missing')) },
      { widget: RUN_BY, scope: { highlightTrace: TRACE } },
    );
    expect((await screen.findByRole('alert')).textContent).toContain('shard missing');
    expect(runQueries).toEqual([]);
  });

  test('loading shows a status and no chart', async () => {
    const real = await linked();
    mount({ ...real, metric: () => new Promise(() => {}) }, { widget: RUN_BY });
    expect((await screen.findByRole('status')).textContent).toBe('Loading');
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('a report with no metrics says so', async () => {
    const real = await linked();
    mount({ ...real, manifest: { ...real.manifest, range: null } }, { widget: RUN_BY });
    expect(await screen.findByText('This report has no metrics')).toBeTruthy();
  });

  test('a window with no runs says so', async () => {
    mount(await linked(), { widget: RUN_BY, scope: { window: { start: 5000 * S, end: 6000 * S } } });
    expect(await screen.findByText('No data points in this window')).toBeTruthy();
  });

  describe('on the page', () => {
    const DASH: Dashboard = DashboardSchema.parse({
      id: 'runs',
      title: 'Runs',
      variables: SERVICES,
      widgets: [
        {
          type: 'metric',
          title: 'Jobs',
          x: 0,
          y: 0,
          w: 12,
          h: 12,
          queries: [CPU],
          exemplars: true,
          ...RUN_BY,
        },
      ],
    });
    const page = (): Promise<DataSource> =>
      linked({
        ...report.manifest,
        config: { ...report.manifest.config, dashboards: [{ source: 'otel-html.yaml', dashboard: DASH }] },
      });

    test('a click on a dot filters the page without re-running the chart or collapsing it', async () => {
      renderShell('#/dashboards/runs', await page());
      const chart = await screen.findByRole('img', { name: /lines over/ });
      const before = chart.getAttribute('aria-label');
      const queried = runQueries.length;
      expect(guideX()).toBeUndefined();
      clickDot('payments');
      await waitFor(() => expect(currentD()?.vars).toEqual({ 'service.name': 'payments' }));
      await waitFor(() => expect(guideX()).toBeDefined());
      expect(runQueries).toHaveLength(queried);
      expect(screen.getByRole('img', { name: /lines over/ }).getAttribute('aria-label')).toBe(before);
    });

    test('a toggle lasts through a variable changing, and is not in the URL', async () => {
      const user = userEvent.setup();
      renderShell('#/dashboards/runs', await page());
      await screen.findByRole('img', { name: /lines over/ });
      await user.click(toggle('Legend'));
      clickDot('payments');
      await waitFor(() => expect(currentD()?.vars).toEqual({ 'service.name': 'payments' }));
      expect(toggle('Legend').getAttribute('aria-pressed')).toBe('true');
      expect(window.location.hash).not.toMatch(/legend|slider/i);
    });

    test('Open in Metrics opens the queries as they are, with the bound run in the where', async () => {
      const user = userEvent.setup();
      const d = encodeURIComponent(JSON.stringify({ vars: { 'service.name': 'payments' } }));
      renderShell(`#/dashboards/runs?d=${d}`, await page());
      await screen.findByRole('img', { name: /lines over/ });
      await user.click(screen.getByRole('button', { name: /Open in Metrics/ }));
      await waitFor(() => expect(window.location.hash.startsWith('#/metrics')).toBe(true));
      const url = parseUrlState(window.location.hash).state;
      expect(url.m?.queries[0]?.where).toBe(`${SERVICE} == "payments"`);
      expect(url.m).toMatchObject({ display: 'lines', exemplars: true });
    });
  });
});

describe('Open in Metrics', () => {
  const DASH: Dashboard = DashboardSchema.parse({
    id: 'svc',
    title: 'Svc',
    variables: ['service.name'],
    widgets: [
      {
        type: 'metric',
        x: 0,
        y: 0,
        w: 12,
        h: 12,
        queries: [CPU],
        exemplars: true,
        display: 'area',
        scale: 'log',
      },
    ],
  });

  test('carries the effective where, the display, scale and the page window', async () => {
    const user = userEvent.setup();
    const ds = await linked({
      ...report.manifest,
      config: { ...report.manifest.config, dashboards: [{ source: 'otel-html.yaml', dashboard: DASH }] },
    });
    const d = encodeURIComponent(JSON.stringify({ vars: { 'service.name': 'payments' } }));
    renderShell(`#/dashboards/svc?t=0~120000000000&d=${d}`, ds);
    await user.click(await screen.findByRole('button', { name: /Open in Metrics/ }));
    await waitFor(() => expect(window.location.hash.startsWith('#/metrics')).toBe(true));
    const url = parseUrlState(window.location.hash).state;
    expect(url.m?.queries[0]?.where).toBe(`${SERVICE} == "payments"`);
    expect(url.m).toMatchObject({ display: 'area', scale: 'log', split: false, exemplars: true });
    expect(url.t).toBe('0~120000000000');
  });

  test('the grid mode has no Open in Metrics', async () => {
    renderShell('#/dashboards/fusion', await linked());
    await screen.findAllByRole('region');
    expect(screen.queryByRole('button', { name: /Open in Metrics/ })).toBeNull();
  });
});
