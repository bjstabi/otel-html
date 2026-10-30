import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const charts = vi.hoisted((): { label: string; option: unknown }[] => []);
vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { option: unknown; ariaLabel: string }): React.JSX.Element => {
    charts.push({ label: p.ariaLabel, option: p.option });
    return <div role="img" aria-label={p.ariaLabel} />;
  },
}));

import type { AnyValue } from '../../src/model/anyvalue.js';
import type { ResourceRecord } from '../../src/model/records.js';
import { createDataSource, type DataSource } from '../../src/viewer/data/data-source.js';
import { explorerFilter, MetricGrid, OTHER_LEFT_OUT } from '../../src/viewer/metrics/metric-grid.js';
import { GoToContext } from '../../src/viewer/shell/go-to.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';
import {
  buildEmbeddedMetricsReport,
  type Fixture,
  LINKED_PAYMENTS_SPAN,
  LINKED_TRACE,
  NO_METRICS_LOG,
  PAYMENTS_LOG,
  RPC_METRICS,
  SUPERSET_CPU,
} from './report-fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let report: Fixture;
beforeAll(async () => {
  report = await buildEmbeddedMetricsReport();
});
beforeEach(() => {
  window.location.hash = '';
  charts.length = 0;
});
afterEach(() => {
  cleanup();
});

/** Every `metricsForResources` lookup the panels started, so a test can wait for them to settle. */
let lookups: Promise<unknown>[] = [];

async function renderAt(hash: string, over: Partial<DataSource> = {}): Promise<void> {
  const real = await createDataSource(createScriptedLoader(report.files), report.manifest, 10_000_000);
  lookups = [];
  const ds: DataSource = {
    ...real,
    ...over,
    metricsForResources: (rs: Parameters<typeof real.metricsForResources>[0]) => {
      const p = real.metricsForResources(rs);
      lookups.push(p);
      return p;
    },
  };
  window.location.hash = hash;
  render(
    <ThemeProvider>
      <Shell dataSource={ds} history={createHashHistory(window)} />
    </ThemeProvider>,
  );
}

/** Waits until the metric lookup has been started and has settled, so the tab set is decided. */
async function metricLookupSettled(): Promise<void> {
  await waitFor(() => expect(lookups.length).toBeGreaterThan(0));
  await act(async () => {
    await Promise.allSettled(lookups);
  });
}

/** A line item is `[time, value]`, or `{ value: [time, value] }` for an isolated point drawn as a dot. */
type LineItem = [number, number | null] | { value: [number, number | null] };

function lineValues(option: unknown): number[] {
  const series = (option as { series?: { type?: string; data?: LineItem[] }[] }).series ?? [];
  return series
    .filter((x) => x.type === 'line')
    .flatMap((x) => x.data ?? [])
    .map((p) => (Array.isArray(p) ? p : p.value)[1])
    .flatMap((v) => (v === null ? [] : [v]));
}

interface ScatterItem {
  traceId: string;
  symbolSize: number;
  itemStyle: { borderWidth: number };
}

function exemplarsOf(option: unknown): ScatterItem[] {
  const series = (option as { series?: { name?: string; data?: ScatterItem[] }[] }).series ?? [];
  return series.find((s) => s.name === 'exemplars')?.data ?? [];
}

const group = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${name}`) });

describe('MetricGrid', () => {
  test('a payments log has a Metrics tab: process expanded, http collapsed', async () => {
    const user = userEvent.setup();
    await renderAt(`#/logs?log=${PAYMENTS_LOG}`);
    const panel = await screen.findByTestId('log-panel');
    await user.click(await within(panel).findByRole('tab', { name: 'Metrics' }));
    const grid = await within(panel).findByTestId('metric-grid');
    expect(within(grid).getByText('service.name')).toBeTruthy();
    expect(within(grid).getByText('payments')).toBeTruthy();
    expect(within(grid).getByText('runner-7')).toBeTruthy();
    expect(within(grid).getByText('± 5 min')).toBeTruthy();
    expect(group('process').getAttribute('aria-expanded')).toBe('true');
    expect(group('http').getAttribute('aria-expanded')).toBe('false');
    // Namespace order: process before http.
    const groups = [...grid.querySelectorAll('button[aria-expanded]')].map((b) => b.textContent ?? '');
    expect(groups).toEqual(['process.*2 charts', 'http.*2 charts', `rpc.*${RPC_METRICS} charts`]);
    expect(await within(grid).findByRole('img', { name: 'process.cpu.utilization: 1 series' })).toBeTruthy();
    expect(within(grid).getByRole('img', { name: 'process.memory.usage: 1 series' })).toBeTruthy();
    expect(within(grid).queryByRole('img', { name: /http\.server\.request\.duration/ })).toBeNull();
    expect(within(grid).getByRole('button', { name: 'S' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('a size change redraws loaded charts in place: no skeleton while the new size loads', async () => {
    const user = userEvent.setup();
    await renderAt(`#/logs?log=${PAYMENTS_LOG}&ltab=metrics`);
    const grid = await screen.findByTestId('metric-grid');
    const name = 'process.cpu.utilization: 1 series';
    await within(grid).findByRole('img', { name });
    const card = within(grid).getByRole('region', { name: 'process.cpu.utilization' });
    await user.click(within(grid).getByRole('button', { name: 'L' }));
    // Straight after the click the old chart is still drawn, marked busy, never the skeleton.
    expect(within(grid).getByRole('img', { name })).toBeTruthy();
    expect(within(grid).getByRole('region', { name: 'process.cpu.utilization' })).toBe(card);
    await waitFor(() => expect(card.getAttribute('aria-busy')).not.toBe('true'));
    expect(within(grid).getByRole('img', { name })).toBeTruthy();
  });

  test('a card waiting to scroll into view is not busy: only a running load is', async () => {
    // An observer that never reports an intersection: every card stays out of view.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    try {
      await renderAt(`#/logs?log=${PAYMENTS_LOG}&ltab=metrics`);
      const grid = await screen.findByTestId('metric-grid');
      const card = await within(grid).findByRole('region', { name: 'process.cpu.utilization' });
      expect(card.getAttribute('aria-busy')).not.toBe('true');
      expect(within(grid).queryByRole('img', { name: /process\.cpu\.utilization/ })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('expanding http draws request duration with the linked trace exemplar highlighted', async () => {
    const user = userEvent.setup();
    await renderAt(`#/logs?log=${PAYMENTS_LOG}&ltab=metrics`);
    const grid = await screen.findByTestId('metric-grid');
    await user.click(group('http'));
    await within(grid).findByRole('img', { name: 'http.server.request.duration: 1 series' });
    await waitFor(() => {
      const last = charts.filter((c) => c.label.startsWith('http.server.request.duration')).at(-1);
      const ex = exemplarsOf(last?.option);
      const hit = ex.find((e) => e.traceId === LINKED_TRACE);
      expect(hit?.symbolSize).toBe(12);
      expect(hit?.itemStyle.borderWidth).toBe(3);
    });
  });

  test('the trace panel draws one line per resource of a two-service trace', async () => {
    await renderAt(`#/traces/trace/${LINKED_TRACE}?tab=metrics`);
    const grid = await screen.findByTestId('metric-grid');
    expect(await within(grid).findByRole('img', { name: 'process.cpu.utilization: 2 series' })).toBeTruthy();
    expect(within(grid).getByRole('img', { name: 'process.memory.usage: 2 series' })).toBeTruthy();
    expect(within(grid).getByText('checkout, payments')).toBeTruthy();
  });

  test('the span section shows the metrics of the span resource', async () => {
    await renderAt(`#/traces/trace/${LINKED_TRACE}?span=${LINKED_PAYMENTS_SPAN}&stab=metrics`);
    const section = await screen.findByRole('region', { name: 'Span details' });
    const grid = await within(section).findByTestId('metric-grid');
    expect(await within(grid).findByRole('img', { name: 'process.cpu.utilization: 1 series' })).toBeTruthy();
    expect(within(grid).getByText('payments')).toBeTruthy();
  });

  test('a log on a resource with no metrics has no Metrics tab', async () => {
    await renderAt(`#/logs?log=${NO_METRICS_LOG}`);
    const panel = await screen.findByTestId('log-panel');
    await within(panel).findByRole('tab', { name: 'Attributes' });
    await metricLookupSettled();
    expect(within(panel).queryByRole('tab', { name: 'Metrics' })).toBeNull();
  });

  test('ltab=metrics on such a log falls back to the first tab, with no URL error', async () => {
    await renderAt(`#/logs?log=${NO_METRICS_LOG}&ltab=metrics`);
    const panel = await screen.findByTestId('log-panel');
    const first = await within(panel).findByRole('tab', { name: 'Attributes' });
    await metricLookupSettled();
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(within(panel).queryByTestId('metric-grid')).toBeNull();
    expect(screen.queryByText(/ltab:/)).toBeNull();
  });

  test('Open in Explorer opens the first expanded group, one query per metric, filtered to the resource', async () => {
    const user = userEvent.setup();
    await renderAt(`#/logs?log=${PAYMENTS_LOG}&ltab=metrics`);
    const grid = await screen.findByTestId('metric-grid');
    await user.click(within(grid).getByRole('button', { name: 'Open in Explorer →' }));
    await waitFor(() => expect(window.location.hash.startsWith('#/metrics?')).toBe(true));
    const { state, errors } = parseUrlState(window.location.hash);
    expect(errors).toEqual([]);
    const m = state.m;
    expect(m?.queries.map((q) => q.metric)).toEqual(['process.cpu.utilization', 'process.memory.usage']);
    expect(m?.queries.map((q) => q.id)).toEqual(['a', 'b']);
    for (const q of m?.queries ?? []) {
      // The superset resource (payments + process.pid) also reports a process metric: the link excludes it.
      expect(q.where).toBe(
        'resource.attributes["service.name"] == "payments" and resource.attributes["host.name"] == "runner-7"' +
          ' and resource.attributes["process.pid"] == nil',
      );
      expect(q.show).toBe('avg');
    }
    expect(m?.split).toBe(true);
    // ± 5 min around 60.2 s, clamped to the run (0 s .. 121 s).
    expect(state.t).toBe(`0~${121_000_000_000}`);
  });

  test('a payments chart holds only payments series, not those of a resource with more attributes', async () => {
    await renderAt(`#/logs?log=${PAYMENTS_LOG}&ltab=metrics`);
    const grid = await screen.findByTestId('metric-grid');
    await within(grid).findByRole('img', { name: 'process.cpu.utilization: 1 series' });
    const cpu = charts.filter((c) => c.label.startsWith('process.cpu.utilization')).at(-1);
    const values = lineValues(cpu?.option);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v < 1)).toBe(true);
    expect(values).not.toContain(SUPERSET_CPU);
  });

  test('a metric with a cap-folded other series says it is left out', async () => {
    const real = await createDataSource(createScriptedLoader(report.files), report.manifest, 10_000_000);
    const metric: DataSource['metric'] = async (id) => {
      const m = await real.metric(id);
      const [first] = m.series;
      if (first === undefined) return m;
      return {
        ...m,
        series: [...m.series, { def: { ...first.def, id: 9999, other: true }, resource: null, scope: null }],
      };
    };
    await renderAt(`#/logs?log=${PAYMENTS_LOG}&ltab=metrics`, { metric });
    const grid = await screen.findByTestId('metric-grid');
    await within(grid).findByRole('img', { name: 'process.cpu.utilization: 1 series' });
    const card = within(grid).getByRole('region', { name: 'process.cpu.utilization' });
    expect(within(card).getByRole('list', { name: 'Notes' }).textContent).toContain(OTHER_LEFT_OUT);
  });

  test('Open in Explorer says it takes only the first 10 metrics of a larger group', async () => {
    const user = userEvent.setup();
    await renderAt(`#/logs?log=${PAYMENTS_LOG}&ltab=metrics`);
    const grid = await screen.findByTestId('metric-grid');
    await user.click(group('process'));
    await user.click(group('rpc'));
    expect(within(grid).getByRole('note').textContent).toContain(
      `first 10 of the ${RPC_METRICS} rpc.* metrics`,
    );
    await user.click(within(grid).getByRole('button', { name: 'Open in Explorer →' }));
    await waitFor(() => expect(window.location.hash.startsWith('#/metrics?')).toBe(true));
    const m = parseUrlState(window.location.hash).state.m;
    expect(m?.queries.map((q) => q.metric)).toEqual(
      Array.from({ length: 10 }, (_, i) => `rpc.m${String(i + 1).padStart(2, '0')}`),
    );
  });
});

describe('explorerFilter', () => {
  const str = (value: string): AnyValue => ({ kind: 'string', value });
  const res = (attrs: [string, AnyValue][]): ResourceRecord => ({
    attributes: new Map(attrs),
    droppedAttributesCount: 0,
    schemaUrl: '',
  });
  const svc: [string, AnyValue] = ['service.name', str('a')];

  test('excludes a matching resource by one of its extra attributes, and leaves non-matching ones alone', () => {
    const origin = res([svc]);
    const f = explorerFilter(
      [origin],
      [origin, res([svc, ['b', str('1')], ['c', str('2')]]), res([['service.name', str('z')]])],
    );
    expect(f).toEqual({
      where: 'resource.attributes["service.name"] == "a" and resource.attributes["b"] == nil',
      by: [],
      unexcluded: 0,
    });
  });

  test('counts a resource that differs only in an attribute a filter cannot compare', () => {
    const tags = (v: string): [string, AnyValue] => ['tags', { kind: 'array', values: [str(v)] }];
    const f = explorerFilter([res([svc, tags('x')])], [res([svc, tags('y')])]);
    expect(f.where).toBe('resource.attributes["service.name"] == "a"');
    expect(f.unexcluded).toBe(1);
  });

  test('an origin that nothing can tell apart gives no where, and every other such resource is unexcluded', () => {
    const tags = (v: string): [string, AnyValue] => ['tags', { kind: 'array', values: [str(v)] }];
    const f = explorerFilter([res([tags('x')])], [res([tags('y')]), res([tags('z')])]);
    expect(f.where).toBeNull();
    expect(f.unexcluded).toBe(2);
    // One with an extra attribute is excluded by it instead.
    const g = explorerFilter([res([tags('x')])], [res([svc, tags('y')])]);
    expect(g.where).toBe('resource.attributes["service.name"] == nil');
    expect(g.unexcluded).toBe(0);
  });

  test('a resource slipping through two origin clauses is counted once', () => {
    const tags = (v: string): [string, AnyValue] => ['tags', { kind: 'array', values: [str(v)] }];
    const other = res([svc, tags('y')]);
    const f = explorerFilter([res([svc, tags('x')]), res([svc, tags('w')])], [other]);
    expect(f.unexcluded).toBe(1);
  });

  test('two origin resources are or-ed and drawn one line each', () => {
    const b = res([['service.name', str('b')]]);
    const f = explorerFilter([res([svc]), b], []);
    expect(f.where).toBe(
      '(resource.attributes["service.name"] == "a") or (resource.attributes["service.name"] == "b")',
    );
    expect(f.by).toEqual(['resource.attributes["service.name"]']);
  });
});

describe('MetricGrid embedded in a dashboard', () => {
  test('a dashboard origin has no marker or +- 5 min label, and the band reaches every chart', async () => {
    const real = await createDataSource(createScriptedLoader(report.files), report.manifest, 10_000_000);
    const rs = (await real.metricCatalog()).resources();
    render(
      <ThemeProvider>
        <GoToContext.Provider value={() => undefined}>
          <MetricGrid
            dataSource={real}
            origin={{
              kind: 'dashboard',
              resources: rs,
              at: null,
              window: { start: 0, end: 120e9 },
              traceId: null,
            }}
            band={{ start: 10e9, end: 20e9 }}
            onSelectTrace={() => undefined}
          />
        </GoToContext.Provider>
      </ThemeProvider>,
    );
    await screen.findByRole('img', { name: /^process\.cpu\.utilization/ });
    expect(screen.queryByText('± 5 min')).toBeNull();
    expect(screen.queryByText('this log')).toBeNull();
    const option = charts.at(-1)?.option as { series: { markArea?: { data: { xAxis: number }[][] } }[] };
    expect(option.series.find((x) => x.markArea !== undefined)?.markArea?.data).toEqual([
      [{ xAxis: 10e9 }, { xAxis: 20e9 }],
    ]);
  });
});
