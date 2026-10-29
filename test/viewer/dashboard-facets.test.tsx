import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';

/** The chart is replaced by its option so the tests read the bars. */
vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string; option: unknown }): React.JSX.Element => (
    <div role="img" aria-label={p.ariaLabel} data-option={JSON.stringify(p.option)} />
  ),
}));

import { type Dashboard, DashboardSchema } from '../../src/dashboards/schema.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { RedSeries } from '../../src/rollups/red.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import type { WidgetActions } from '../../src/viewer/dashboards/dashboard-page.js';
import type { WidgetScope } from '../../src/viewer/dashboards/scope.js';
import { FacetChartWidget } from '../../src/viewer/dashboards/widgets/facet-chart.js';
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
import { baseManifest, dataSourceOf, manifestWith, renderShell } from './dashboard-shell.js';
import { buildEmbeddedMetricsReport } from './report-fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

async function linked(): Promise<DataSource> {
  const report = await buildEmbeddedMetricsReport();
  return createDataSource(createScriptedLoader(report.files), report.manifest, 1);
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

type Input = Record<string, unknown>;

function dashboardOf(widget: Input): Dashboard {
  return DashboardSchema.parse({
    id: 'facets',
    title: 'Facets',
    widgets: [{ x: 0, y: 0, w: 6, h: 10, ...widget }],
  });
}

function mount(ds: DataSource, widget: Input, scope: Partial<WidgetScope> = {}): WidgetActions {
  const dashboard = dashboardOf(widget);
  const w = dashboard.widgets[0];
  if (w === undefined) throw new Error('no widget');
  const actions: WidgetActions = {
    selectWindow: vi.fn(),
    selectTrace: vi.fn(),
    openIn: vi.fn(),
    setLogView: vi.fn(),
    setSubtitle: vi.fn(),
  };
  render(
    <ThemeProvider>
      <SelectionProvider store={createSelectionStore({})}>
        <FacetChartWidget
          widget={w}
          scope={{ ...SCOPE, ...scope }}
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

interface Option {
  yAxis: { data: string[] };
  series: { data: { name: string; value: number }[] }[];
}

async function bars(): Promise<Option['series'][number]['data']> {
  const chart = await screen.findByRole('img');
  const option = JSON.parse(chart.getAttribute('data-option') ?? '{}') as Option;
  return option.series[0]?.data ?? [];
}

const emptySpans = (partial: SpanQueryResult['partial'] = null): SpanQueryResult => ({
  rows: [],
  total: 0,
  facets: new FacetCounts(10, 10),
  buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
  red: new RedSeries(8),
  partial,
});

function spansWith(partial: SpanQueryResult['partial'] = null): SpanQueryResult {
  const facets = new FacetCounts(10, 10);
  facets.add('service.name', 'checkout');
  facets.add('service.name', 'checkout');
  facets.add('service.name', 'payments');
  return { ...emptySpans(partial), total: 3, facets };
}

describe('the Top list and Table widgets', () => {
  test('a top list over service.name has one bar per service', async () => {
    mount(await linked(), { type: 'toplist', signal: 'spans', groupBy: 'service.name' });
    const data = await bars();
    expect(data.map((d) => d.name).sort()).toEqual(['checkout', 'payments']);
    expect(data.map((d) => d.value).sort()).toEqual([1, 1]);
  });

  test('the table shows counts and shares that sum to 100 %', async () => {
    mount(await linked(), { type: 'table', signal: 'spans', groupBy: 'service.name' });
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.length).toBe(2);
    const shares = rows.map((r) => Number.parseInt(within(r).getAllByRole('cell')[2]?.textContent ?? '', 10));
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
    expect(within(table).getAllByRole('columnheader')[1]?.textContent).toBe('Spans');
  });

  test('the logs signal groups logs', async () => {
    mount(await linked(), { type: 'table', signal: 'logs', groupBy: 'service.name' });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader')[1]?.textContent).toBe('Logs');
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(1);
  });

  test('echarts is merged over the top list option', async () => {
    mount(await linked(), {
      type: 'toplist',
      signal: 'spans',
      groupBy: 'service.name',
      echarts: { grid: { left: 7 } },
    });
    const chart = await screen.findByRole('img');
    const option = JSON.parse(chart.getAttribute('data-option') ?? '{}') as {
      grid: { left: number; top: number };
    };
    expect(option.grid).toMatchObject({ left: 7, top: 8 });
  });

  test('a missing key shows the empty state, for either view', async () => {
    const ds = await linked();
    mount(ds, { type: 'toplist', signal: 'spans', groupBy: 'no.such.key' });
    expect(await screen.findByText(/values in this window/)).toBeTruthy();
    expect(screen.getByText('no.such.key').parentElement?.textContent).toBe(
      'No no.such.key values in this window',
    );
    expect(screen.queryByRole('img')).toBeNull();
    cleanup();
    mount(ds, { type: 'table', signal: 'logs', groupBy: 'no.such.key' });
    expect(await screen.findByText(/values in this window/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  test('the subtitle counts the spans or logs', async () => {
    const a = mount(await linked(), { type: 'table', signal: 'spans', groupBy: 'service.name' });
    await waitFor(() => expect(a.setSubtitle).toHaveBeenCalledWith('2 spans'));
  });
});

describe('the Top list and Table widget states', () => {
  test('loading shows a status and no chart', () => {
    mount(
      { ...dataSourceOf(baseManifest), querySpans: () => new Promise<SpanQueryResult>(() => {}) },
      { type: 'toplist', signal: 'spans', groupBy: 'service.name' },
    );
    expect(screen.getByRole('status').textContent).toBe('Loading');
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('a partial scan says how much was read and Scan entire run rereads everything', async () => {
    const calls: boolean[] = [];
    mount(
      {
        ...dataSourceOf(baseManifest),
        querySpans: (q) => {
          calls.push(q.scanAll);
          return Promise.resolve(spansWith(q.scanAll ? null : { scanned: 2, total: 5 }));
        },
      },
      { type: 'table', signal: 'spans', groupBy: 'service.name' },
    );
    expect(await screen.findByText(/from 2 of 5 chunks/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Scan entire run' }));
    await waitFor(() => expect(screen.queryByText(/from 2 of 5 chunks/)).toBeNull());
    expect(calls).toEqual([false, true]);
  });

  test('a failing query shows the error', async () => {
    mount(
      { ...dataSourceOf(baseManifest), queryLogs: () => Promise.reject(new Error('chunk 3 is corrupt')) },
      { type: 'toplist', signal: 'logs', groupBy: 'service.name' },
    );
    expect((await screen.findByRole('alert')).textContent).toContain('chunk 3 is corrupt');
  });

  test('no stale facets are shown as current while an input change reloads', async () => {
    const ds: DataSource = {
      ...dataSourceOf(baseManifest),
      querySpans: (q) =>
        q.text === '' ? Promise.resolve(spansWith()) : new Promise<SpanQueryResult>(() => {}),
    };
    const dashboard = dashboardOf({ type: 'table', signal: 'spans', groupBy: 'service.name' });
    const w = dashboard.widgets[0];
    if (w === undefined || w.type !== 'table') throw new Error('no widget');
    const tree = (text: string): React.JSX.Element => (
      <ThemeProvider>
        <SelectionProvider store={createSelectionStore({})}>
          <FacetChartWidget
            widget={{ ...w, text }}
            scope={SCOPE}
            dashboard={{ dashboard, source: 'x', isDefault: false }}
            height={400}
            dataSource={ds}
            actions={{
              selectWindow: vi.fn(),
              selectTrace: vi.fn(),
              openIn: vi.fn(),
              setLogView: vi.fn(),
              setSubtitle: vi.fn(),
            }}
            variables={[]}
            state={EMPTY_DASHBOARD_STATE}
          />
        </SelectionProvider>
      </ThemeProvider>
    );
    const { rerender } = render(tree(''));
    expect(await screen.findByRole('table')).toBeTruthy();
    rerender(tree('slow'));
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('Open in from a Top list or Table widget', () => {
  test.each([
    ['toplist', 'spans', 'traces'],
    ['table', 'logs', 'logs'],
  ] as const)('a %s over %s opens %s with view and group', async (type, signal, page) => {
    const dashboard = dashboardOf({ type, signal, groupBy: 'service.name' });
    renderShell('#/dashboards/facets', {
      ...(await linked()),
      manifest: manifestWith([dashboard]),
    });
    const button = await screen.findByRole('button', { name: /Open in (Traces|Logs)/ });
    fireEvent.click(button);
    await waitFor(() => expect(window.location.hash.startsWith(`#/${page}`)).toBe(true));
    const state = parseUrlState(window.location.hash).state;
    expect(state.view).toBe(type);
    expect(state.group).toBe('service.name');
  });
});
