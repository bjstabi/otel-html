import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const charts = vi.hoisted((): { label: string; option: unknown }[] => []);
vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { option: unknown; ariaLabel: string }): React.JSX.Element => {
    charts.push({ label: p.ariaLabel, option: p.option });
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

import { type Dashboard, DashboardSchema } from '../../src/dashboards/schema.js';
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
  } = {},
): Mounted {
  const dashboard = DashboardSchema.parse({
    id: 'd',
    title: 'D',
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
