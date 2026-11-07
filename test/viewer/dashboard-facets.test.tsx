import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/** The chart is replaced by its option so the tests read the bars. */
vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string; option: unknown }): React.JSX.Element => (
    <div role="img" aria-label={p.ariaLabel} data-option={JSON.stringify(p.option)} />
  ),
}));

import { type Dashboard, DashboardSchema } from '../../src/dashboards/schema.js';
import type { TraceId } from '../../src/model/ids.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import type { WidgetActions } from '../../src/viewer/dashboards/dashboard-page.js';
import type { WidgetScope } from '../../src/viewer/dashboards/scope.js';
import { FacetChartWidget, suggestKeys } from '../../src/viewer/dashboards/widgets/facet-chart.js';
import { count } from '../../src/viewer/dashboards/widgets/subtitle.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { LogQuery, SpanQuery, SpanQueryResult } from '../../src/viewer/data/results.js';
import { EMPTY_DASHBOARD_STATE } from '../../src/viewer/state/dashboard-state.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import {
  baseManifest,
  dataSourceOf,
  emptyLogResult,
  emptySpanResult,
  manifestWith,
  renderShell,
} from './dashboard-shell.js';
import { fusionSource } from './fusion-source.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const linked = (): Promise<DataSource> => Promise.resolve(fusionSource());

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
    setVariable: vi.fn(),
    setControls: vi.fn(),
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
          controls={null}
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

function spansWith(): SpanQueryResult {
  const facets = new FacetCounts(10, 10);
  facets.add('service.name', 'checkout');
  facets.add('service.name', 'checkout');
  facets.add('service.name', 'payments');
  return { ...emptySpanResult(), total: 3, facets };
}

function spansMeasured(dropped: number): SpanQueryResult {
  const stat = (group: string, n: number) => ({
    group,
    count: n,
    sum: n * 5,
    avg: 5,
    max: 7,
    p95: 7,
    p99: 7,
  });
  return {
    ...spansWith(),
    // A duration measure keeps `cap` groups; `dropped` says whether the query saw more.
    groups: { groups: [stat('checkout', 1), stat('payments', 1)], cap: 2, dropped },
  };
}

describe('the cap note of a duration measure', () => {
  const widget = (measure: 'count' | 'duration.max') =>
    ({ type: 'toplist', signal: 'spans', groupBy: 'service.name', measure }) as const;
  const over = (dropped: number): DataSource => ({
    ...dataSourceOf(baseManifest),
    querySpans: () => Promise.resolve(spansMeasured(dropped)),
  });

  test('says spans with other values are left out, on one line with the full sentence as its title', async () => {
    mount(over(1), widget('duration.max'));
    const note = await screen.findByText('Spans past the first 2 values left out');
    expect(note.getAttribute('title')).toBe(
      'Measured over the first 2 service.name values; spans with other values are left out',
    );
    expect(note.className).toContain('truncate');
  });

  test('the full sentence is the accessible name, so touch and screen readers get it', async () => {
    mount(over(1), widget('duration.max'));
    const note = await screen.findByRole('status', {
      name: 'Measured over the first 2 service.name values; spans with other values are left out',
    });
    expect(note.textContent).toBe('Spans past the first 2 values left out');
    expect(note.className).toContain('truncate');
  });

  test('count() groups thousands', () => {
    expect(count(1000, 'span')).toBe('1,000 spans');
    expect(count(1, 'log')).toBe('1 log');
  });

  test('is absent when nothing was dropped', async () => {
    mount(over(0), widget('duration.max'));
    await bars();
    expect(screen.queryByText(/left out/)).toBeNull();
  });

  test('is absent for a count measure', async () => {
    mount(over(1), widget('count'));
    await bars();
    expect(screen.queryByText(/left out/)).toBeNull();
  });
});

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

  test('a top list with measure duration.max shows one bar per group with the group max', async () => {
    const ds = await linked();
    const all = await ds.querySpans({
      condition: null,
      text: '',
      window: null,
      mode: 'spans',
      sort: { column: 'start', dir: 'desc' },
      limit: 100000,
      groupBy: null,
      measureBy: null,
      needs: ['rows'],
      facetKeys: null,
    });
    const max = new Map<string, number>();
    for (const r of all.rows) {
      if (!('span' in r)) continue;
      max.set(r.service, Math.max(max.get(r.service) ?? 0, r.durationNs));
    }
    expect(max.size).toBe(2);
    mount(ds, { type: 'toplist', signal: 'spans', groupBy: 'service.name', measure: 'duration.max' });
    const data = await bars();
    expect(data.map((d) => d.name).sort()).toEqual([...max.keys()].sort());
    for (const d of data) {
      const want = max.get(d.name) ?? Number.NaN;
      expect(d.value).toBe(want);
    }
  });

  test.each([
    ['duration.sum', true],
    ['duration.avg', false],
    ['duration.max', false],
  ] as const)('the table with %s shows a Share column: %s', async (measure, share) => {
    mount(await linked(), { type: 'table', signal: 'spans', groupBy: 'service.name', measure });
    const table = await screen.findByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers.includes('Share')).toBe(share);
  });

  test('the table with duration.p95 has a p95 column and no Share', async () => {
    mount(await linked(), {
      type: 'table',
      signal: 'spans',
      groupBy: 'service.name',
      measure: 'duration.p95',
    });
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['service.name', 'p95']);
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

  test('a key that is no facet of the report says so and suggests known keys', async () => {
    const ds = await linked();
    mount(ds, { type: 'toplist', signal: 'spans', groupBy: 'name' });
    expect(await screen.findByText(/is not a facet of this report/)).toBeTruthy();
    expect(screen.getByText('span.name')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    cleanup();
    mount(ds, { type: 'table', signal: 'logs', groupBy: 'no.such.key' });
    expect(await screen.findByText(/is not a facet of this report/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  test('a facet with no values in the window keeps the empty message', async () => {
    mount(
      await linked(),
      { type: 'toplist', signal: 'spans', groupBy: 'service.name' },
      { window: { start: 1, end: 2 } },
    );
    expect(await screen.findByText(/values in this window/)).toBeTruthy();
  });

  test('a pinned facet with no observations keeps the empty message', async () => {
    const pinned = new FacetCounts(10, 10, ['deployment.environment.name']);
    const ds: DataSource = {
      ...fusionSource(),
      querySpans: () => Promise.resolve({ ...emptySpanResult(), facets: pinned }),
    };
    mount(ds, { type: 'toplist', signal: 'spans', groupBy: 'deployment.environment.name' });
    expect(await screen.findByText(/values in this window/)).toBeTruthy();
    expect(screen.queryByText(/is not a facet/)).toBeNull();
  });

  test('a report with no spans or logs keeps the empty message for the core keys', async () => {
    const window = { start: 1, end: 2 };
    const core = (keys: string[]): FacetCounts => new FacetCounts(10, 10, keys);
    const ds: DataSource = {
      ...fusionSource(),
      querySpans: () => Promise.resolve({ ...emptySpanResult(), facets: core(['span.name']) }),
      queryLogs: () => Promise.resolve({ ...emptyLogResult(), facets: core(['severity']) }),
    };
    mount(ds, { type: 'toplist', signal: 'spans', groupBy: 'span.name' }, { window });
    expect(await screen.findByText(/values in this window/)).toBeTruthy();
    expect(screen.queryByText(/is not a facet/)).toBeNull();
    cleanup();
    mount(ds, { type: 'table', signal: 'logs', groupBy: 'severity' }, { window });
    expect(await screen.findByText(/values in this window/)).toBeTruthy();
    expect(screen.queryByText(/is not a facet/)).toBeNull();
  });

  test('the report keys are read only when a widget has no values, and no message shows until they load', async () => {
    const base = fusionSource();
    const queries: SpanQuery[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ds: DataSource = {
      ...base,
      querySpans: async (q, signal) => {
        queries.push(q);
        if (q.facetKeys === null) await gate;
        return base.querySpans(q, signal);
      },
    };
    mount(ds, { type: 'toplist', signal: 'spans', groupBy: 'name' });
    await waitFor(() => expect(queries.some((q) => q.facetKeys === null)).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/values in this window/)).toBeNull();
    expect(screen.queryByText(/is not a facet/)).toBeNull();
    release();
    expect(await screen.findByText(/is not a facet of this report/)).toBeTruthy();
    // The keys query is the unfiltered one, and it asks for facets only.
    const keys = queries.find((q) => q.facetKeys === null);
    expect(keys).toMatchObject({ condition: null, window: null, needs: ['facets'] });
  });

  test('a widget with values never reads the report keys', async () => {
    const base = fusionSource();
    const queries: SpanQuery[] = [];
    const ds: DataSource = {
      ...base,
      querySpans: (q, signal) => {
        queries.push(q);
        return base.querySpans(q, signal);
      },
    };
    mount(ds, { type: 'toplist', signal: 'spans', groupBy: 'service.name' });
    await bars();
    expect(queries.every((q) => q.facetKeys !== null)).toBe(true);
  });

  test('suggestKeys puts suffix matches first, deduplicated and capped', () => {
    expect(suggestKeys(['span.name', 'service.name', 'http.route'], 'name')).toEqual([
      'span.name',
      'service.name',
    ]);
    expect(suggestKeys(['a.x', 'b.x', 'c.x', 'd.x'], 'X')).toEqual(['a.x', 'b.x', 'c.x']);
    expect(suggestKeys(['xname', 'a.name'], 'name')).toEqual(['a.name', 'xname']);
  });

  test('the subtitle counts the spans or logs', async () => {
    const a = mount(await linked(), { type: 'table', signal: 'spans', groupBy: 'service.name' });
    await waitFor(() => expect(a.setSubtitle).toHaveBeenCalledWith('2 spans'));
  });

  test('the scope reaches the query: window, condition and trace, and the subtitle says so', async () => {
    const ds = await linked();
    const queryLogs = vi.spyOn(ds, 'queryLogs');
    const querySpans = vi.spyOn(ds, 'querySpans');
    const trace = 'a'.repeat(32) as TraceId;
    const window = { start: 1, end: 9 };
    const scope = { window, narrowed: true, traceFilter: trace, condition: 'severity_number >= 9' };
    const a = mount(ds, { type: 'table', signal: 'logs', groupBy: 'service.name' }, scope);
    await waitFor(() => expect(a.setSubtitle).toHaveBeenCalledWith('0 logs for the selected trace'));
    // The empty result also reads the report's keys, unfiltered; the widget's own query is the keyed one.
    expect(queryLogs.mock.calls.find(([q]) => q.facetKeys !== null)?.[0]).toMatchObject({
      window,
      traceId: trace,
      condition: 'severity_number >= 9',
    });
    cleanup();
    const b = mount(
      ds,
      { type: 'toplist', signal: 'spans', groupBy: 'service.name' },
      { window, narrowed: true },
    );
    await waitFor(() => expect(b.setSubtitle).toHaveBeenCalledWith('0 spans in selected time'));
    expect(querySpans.mock.calls.find(([q]) => q.facetKeys !== null)?.[0]).toMatchObject({ window });
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

  test.each([
    ['count', ['rows', 'facets']],
    ['duration.max', ['rows', 'facets', 'groups']],
  ] as const)('with measure %s a span widget asks for %j, restricted to its key', async (measure, needs) => {
    const calls: unknown[][] = [];
    mount(
      {
        ...dataSourceOf(baseManifest),
        querySpans: (...args) => {
          calls.push(args);
          return Promise.resolve(spansWith());
        },
      },
      { type: 'table', signal: 'spans', groupBy: 'service.name', measure },
    );
    await screen.findByRole('table');
    const [q, signal] = calls[0] as [SpanQuery, unknown];
    expect(q).toMatchObject({ needs, facetKeys: ['service.name'], limit: 1 });
    expect(q.measureBy).toBe(measure === 'count' ? null : 'service.name');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]).toHaveLength(2);
  });

  test('a log widget asks for rows and facets, restricted to its key, with no progress function', async () => {
    const calls: unknown[][] = [];
    mount(
      {
        ...dataSourceOf(baseManifest),
        queryLogs: (...args) => {
          calls.push(args);
          return Promise.resolve(emptyLogResult());
        },
      },
      { type: 'table', signal: 'logs', groupBy: 'service.name' },
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const [q, signal] = calls[0] as [LogQuery, unknown];
    expect(q).toMatchObject({ needs: ['rows', 'facets'], facetKeys: ['service.name'] });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]).toHaveLength(2);
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
              setVariable: vi.fn(),
              setControls: vi.fn(),
            }}
            variables={[]}
            controls={null}
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
