import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

interface Zr {
  on: (name: string, h: (e: unknown) => void) => void;
  off: () => void;
}
const zrHandlers = new Map<string, (e: unknown) => void>();
/** 1 px per second on x, so a click at `offsetX` is `offsetX` seconds into the run. */
const fakeChart = {
  containPixel: (): boolean => true,
  getZr: (): Zr => ({ on: (n, h) => zrHandlers.set(n, h), off: () => undefined }),
  convertFromPixel: (_f: unknown, p: [number, number]): [number, number] => [p[0] * 1e9, p[1]],
  convertToPixel: (_f: unknown, p: [number, number]): [number, number] => [p[0] / 1e9, p[1]],
};

vi.mock('../../src/viewer/components/chart.js', async () => {
  const { useEffect } = await import('react');
  return {
    Chart: (p: { ariaLabel: string; onInstance?: (c: unknown) => void }): React.JSX.Element => {
      useEffect(() => {
        p.onInstance?.(fakeChart);
        return () => p.onInstance?.(null);
      }, [p.onInstance]);
      return <div role="img" aria-label={p.ariaLabel} />;
    },
  };
});

import type { MetricPageState } from '../../src/query/metric-query.js';
import { createDataSource } from '../../src/viewer/data/data-source.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { defaultMetricState } from '../../src/viewer/state/metric-state.js';
import { parseUrlState, serializeUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';
import { buildMetricExplorerReport, type Fixture } from './report-fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let report: Fixture;
beforeAll(async () => {
  report = await buildMetricExplorerReport();
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  zrHandlers.clear();
});

const S = 1_000_000_000;

async function renderAt(hash: string): Promise<void> {
  const ds = await createDataSource(createScriptedLoader(report.files), report.manifest, 10_000_000);
  window.location.hash = hash;
  render(
    <ThemeProvider>
      <Shell dataSource={ds} history={createHashHistory(window)} />
    </ThemeProvider>,
  );
}

/** `#/metrics?m=…` with one query on `metric`. */
function metricsHash(
  over: Partial<MetricPageState['queries'][number]>,
  state: Partial<MetricPageState> = {},
): string {
  const seed = defaultMetricState(null);
  const m: MetricPageState = {
    ...seed,
    ...state,
    queries: [
      { ...seed.queries[0], id: 'a', metric: '', show: '', ...over } as MetricPageState['queries'][number],
    ],
  };
  return `#/metrics?${serializeUrlState({ m })}`;
}

function urlMetrics(): MetricPageState | undefined {
  return parseUrlState(window.location.hash).state.m;
}

describe('Metrics Explorer', () => {
  test('an empty URL shows query a on the first catalog metric with its default show', async () => {
    await renderAt('#/metrics');
    expect(screen.getByRole('heading', { name: 'Metrics', level: 1 })).toBeTruthy();
    const row = await screen.findByRole('listitem', { name: 'Query a' });
    const picker = within(row).getByRole('button', { name: /^Metric of a/ });
    await waitFor(() => expect(picker.textContent).toContain('http.server.requests'));
    expect(picker.textContent).toContain('SUM · monotonic');
    expect((within(row).getByLabelText('Show of a') as HTMLSelectElement).value).toBe('rate');
    expect(urlMetrics()?.queries[0]).toMatchObject({ id: 'a', metric: 'http.server.requests', show: 'rate' });
    expect(await screen.findByRole('img', { name: /: 1 series$/ })).toBeTruthy();
    expect(screen.queryByText('Coming in a later release')).toBeNull();
  });

  test('changing show to p99 updates m in the URL', async () => {
    const user = userEvent.setup();
    await renderAt(metricsHash({ metric: 'http.server.request.duration', show: 'p95' }));
    const show = (await screen.findByLabelText('Show of a')) as HTMLSelectElement;
    expect([...show.options].map((o) => o.value)).toEqual([
      'p50',
      'p75',
      'p90',
      'p95',
      'p99',
      'count',
      'sum',
      'avg',
    ]);
    await user.selectOptions(show, 'p99');
    await waitFor(() => expect(urlMetrics()?.queries[0]?.show).toBe('p99'));
    expect(urlMetrics()?.queries[0]?.metric).toBe('http.server.request.duration');
  });

  test('adding a formula a * 2 renders a second series', async () => {
    const user = userEvent.setup();
    await renderAt('#/metrics');
    await screen.findByRole('img', { name: /: 1 series$/ });
    await user.click(screen.getByRole('button', { name: '+ Formula' }));
    const expr = screen.getByLabelText('Expression of f1');
    await user.clear(expr);
    await user.type(expr, 'a * 2{Enter}');
    expect(await screen.findByRole('img', { name: /: 2 series$/ })).toBeTruthy();
    expect(urlMetrics()?.formulas).toEqual([{ id: 'f1', expr: 'a * 2', alias: null, hidden: false }]);
  });

  test('Heatmap and Distribution are disabled with only a gauge query, enabled with a histogram', async () => {
    await renderAt(metricsHash({ metric: 'checkout.queue.depth', show: 'avg' }));
    await screen.findByRole('img', { name: /series$/ });
    const heatmap = screen.getByRole('button', { name: 'Heatmap' }) as HTMLButtonElement;
    expect(heatmap.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Distribution' }) as HTMLButtonElement).disabled).toBe(true);
    expect(heatmap.title).toBe('needs a visible histogram query');
    cleanup();
    await renderAt(metricsHash({ metric: 'http.server.request.duration', show: 'p95' }));
    await screen.findByRole('img', { name: /series$/ });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Heatmap' }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  test('an ambiguous name shows the kind/unit picker, and choosing one sets kind and unit', async () => {
    const user = userEvent.setup();
    await renderAt(metricsHash({ metric: 'jobs.active', show: 'avg' }));
    const pick = (await screen.findByLabelText('Definition of jobs.active')) as HTMLSelectElement;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['choose…', 'GAUGE · 1', 'SUM · {job}']);
    await user.selectOptions(pick, 'SUM · {job}');
    await waitFor(() => expect(urlMetrics()?.queries[0]).toMatchObject({ kind: 'sum', unit: '{job}' }));
    expect(screen.queryByLabelText('Definition of jobs.active')).toBeNull();
  });

  test('queries with different units force one chart per query, with a note', async () => {
    const seed = defaultMetricState(null).queries[0];
    const m: MetricPageState = {
      ...defaultMetricState(null),
      queries: [
        {
          ...seed,
          id: 'a',
          metric: 'http.server.requests',
          show: 'rate',
        } as MetricPageState['queries'][number],
        {
          ...seed,
          id: 'b',
          metric: 'http.server.request.duration',
          show: 'p95',
        } as MetricPageState['queries'][number],
      ],
    };
    await renderAt(`#/metrics?${serializeUrlState({ m })}`);
    expect(await screen.findByText('different units: one chart per query')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('img', { name: /series$/ })).toHaveLength(2));
    const split = screen.getByRole('switch', { name: 'One chart per query' });
    expect(split.getAttribute('aria-checked')).toBe('true');
  });

  test('the click menu opens Logs on the bucket window and says the point-attribute filter was dropped', async () => {
    const user = userEvent.setup();
    await renderAt(
      metricsHash({
        metric: 'http.server.requests',
        show: 'increase',
        where: 'attributes["http.route"] == "/a"',
      }),
    );
    await screen.findByRole('img', { name: /: 1 series$/ });
    await waitFor(() => expect(zrHandlers.has('click')).toBe(true));
    act(() => zrHandlers.get('click')?.({ offsetX: 1000, offsetY: 5, event: { clientX: 10, clientY: 10 } }));
    await user.click(await screen.findByRole('menuitem', { name: 'Logs in this window' }));
    await waitFor(() => expect(window.location.hash.startsWith('#/logs')).toBe(true));
    const url = parseUrlState(window.location.hash).state;
    expect(url.q).toBeUndefined();
    expect(url.t).toMatch(/^\d+~\d+$/);
    const [start, end] = (url.t ?? '').split('~').map(Number);
    expect(start).toBeLessThanOrEqual(1000 * S);
    expect(end).toBeGreaterThan(1000 * S);
    expect(await screen.findByRole('status', { name: 'Filter not carried over' })).toBeTruthy();
  });

  test('a resource filter carries to Traces from the click menu', async () => {
    const user = userEvent.setup();
    const where = 'resource.attributes["service.name"] == "checkout"';
    await renderAt(metricsHash({ metric: 'http.server.requests', show: 'increase', where }));
    await screen.findByRole('img', { name: /: 1 series$/ });
    await waitFor(() => expect(zrHandlers.has('click')).toBe(true));
    act(() => zrHandlers.get('click')?.({ offsetX: 1000, offsetY: 5, event: { clientX: 10, clientY: 10 } }));
    await user.click(await screen.findByRole('menuitem', { name: 'Traces in this window' }));
    await waitFor(() => expect(window.location.hash.startsWith('#/traces')).toBe(true));
    expect(parseUrlState(window.location.hash).state.q).toBe(where);
  });

  test("in a combined chart the click menu carries the where of the query whose line is nearest, not a's", async () => {
    const user = userEvent.setup();
    const seed = defaultMetricState(null).queries[0];
    const on = (id: string, service: string): MetricPageState['queries'][number] =>
      ({
        ...seed,
        id,
        metric: 'http.server.requests',
        show: 'increase',
        where: `resource.attributes["service.name"] == "${service}"`,
      }) as MetricPageState['queries'][number];
    // At 1000 s, a (checkout: /a + /b) increases by 22 and b (payments) by 5; the fake chart maps a value to y px.
    const m: MetricPageState = {
      ...defaultMetricState(null),
      queries: [on('a', 'checkout'), on('b', 'payments')],
    };
    await renderAt(`#/metrics?${serializeUrlState({ m })}`);
    await screen.findByRole('img', { name: /: 2 series$/ });
    await waitFor(() => expect(zrHandlers.has('click')).toBe(true));
    act(() => zrHandlers.get('click')?.({ offsetX: 1000, offsetY: 6, event: { clientX: 10, clientY: 10 } }));
    await user.click(await screen.findByRole('menuitem', { name: 'Traces in this window' }));
    await waitFor(() => expect(window.location.hash.startsWith('#/traces')).toBe(true));
    expect(parseUrlState(window.location.hash).state.q).toBe(
      'resource.attributes["service.name"] == "payments"',
    );
  });

  test('an unknown metric in the URL says so on its row', async () => {
    await renderAt(metricsHash({ metric: 'no.such.metric', show: 'avg' }));
    expect(await screen.findByText('no metric named no.such.metric in this report')).toBeTruthy();
  });

  describe('Copy as dashboard widget', () => {
    test('copies the queries as a metric widget', async () => {
      const user = userEvent.setup();
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await renderAt(metricsHash({ metric: 'http.server.request.duration', show: 'p95' }));
      await screen.findByLabelText('Show of a');
      await user.click(screen.getByRole('button', { name: 'Export' }));
      await user.click(await screen.findByRole('menuitem', { name: /Copy as dashboard widget/ }));
      await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
      const yaml = String((writeText.mock.calls[0] as unknown[])[0]);
      expect(yaml).toContain('type: metric');
      expect(yaml).toContain('metric: http.server.request.duration');
      expect(yaml).toContain('show: p95');
    });

    test('is disabled in the Distribution display, with the reason', async () => {
      const user = userEvent.setup();
      await renderAt(
        metricsHash({ metric: 'http.server.request.duration', show: 'p95' }, { display: 'distribution' }),
      );
      await screen.findByLabelText('Show of a');
      await user.click(screen.getByRole('button', { name: 'Export' }));
      const item = await screen.findByRole('menuitem', { name: /Copy as dashboard widget/ });
      expect(item.getAttribute('aria-disabled')).toBe('true');
      expect(item.textContent).toContain("The Distribution display can't become a widget");
    });
  });
});
