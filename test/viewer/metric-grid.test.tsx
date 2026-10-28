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

import { createDataSource } from '../../src/viewer/data/data-source.js';
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

async function renderAt(hash: string): Promise<void> {
  const ds = await createDataSource(createScriptedLoader(report.files), report.manifest, 10_000_000);
  window.location.hash = hash;
  render(
    <ThemeProvider>
      <Shell dataSource={ds} history={createHashHistory(window)} />
    </ThemeProvider>,
  );
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
    expect(groups).toEqual(['process.*2 charts', 'http.*2 charts']);
    expect(await within(grid).findByRole('img', { name: 'process.cpu.utilization: 1 series' })).toBeTruthy();
    expect(within(grid).getByRole('img', { name: 'process.memory.usage: 1 series' })).toBeTruthy();
    expect(within(grid).queryByRole('img', { name: /http\.server\.request\.duration/ })).toBeNull();
    expect(within(grid).getByRole('button', { name: 'S' }).getAttribute('aria-pressed')).toBe('true');
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
    // Give the metric lookup time to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(within(panel).queryByRole('tab', { name: 'Metrics' })).toBeNull();
  });

  test('ltab=metrics on such a log falls back to the first tab, with no URL error', async () => {
    await renderAt(`#/logs?log=${NO_METRICS_LOG}&ltab=metrics`);
    const panel = await screen.findByTestId('log-panel');
    const first = await within(panel).findByRole('tab', { name: 'Attributes' });
    await new Promise((r) => setTimeout(r, 50));
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
      expect(q.where).toBe(
        'resource.attributes["service.name"] == "payments" and resource.attributes["host.name"] == "runner-7"',
      );
      expect(q.show).toBe('avg');
    }
    expect(m?.split).toBe(true);
    // ± 5 min around 60.2 s, clamped to the run (0 s .. 121 s).
    expect(state.t).toBe(`0~${121_000_000_000}`);
  });
});
