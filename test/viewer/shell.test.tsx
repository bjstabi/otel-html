import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Manifest } from '../../src/format/manifest.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { RedSeries } from '../../src/rollups/red.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { App } from '../../src/viewer/app.js';
import type { DataSource, SpanQueryResult } from '../../src/viewer/data/data-source.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { stepWindow } from '../../src/viewer/shell/time-range.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { detailOf, TRACE_ID, traceRow } from './trace-rows.js';

// jsdom has no layout or ResizeObserver, which ECharts needs; the explorer's charts are covered by e2e.
vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 3_600_000_000_000;
const manifest: Manifest = {
  formatVersion: 1,
  otelHtmlVersion: '0.0.0',
  title: 'Checkout load test',
  epochUnixNano: '1700000000000000000',
  createdAt: '2023-11-14T22:13:20.000Z',
  updatedAt: '2023-11-14T22:13:20.000Z',
  complete: true,
  range: { start: 0, end: 10 * HOUR },
  totals: { spans: 1234, logs: 56, metrics: 7 },
  decodedBytes: 1000,
  chunks: [],
  rollups: [],
  traceShards: [],
  config: { viewer: { eagerBudgetBytes: 75_000_000, listCap: 10_000, theme: 'system' } },
};

function unused(): never {
  throw new Error('this test must not reach that part of the data source');
}
const emptyResult = (): SpanQueryResult => ({
  rows: [],
  total: 0,
  facets: new FacetCounts(10, 10),
  buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
  red: new RedSeries(8),
  partial: null,
});
const dataSource: DataSource = {
  manifest,
  strategy: 'eager',
  landing: () =>
    Promise.resolve({
      facets: new FacetCounts(10, 10),
      buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
      red: new RedSeries(8),
      durations: new Map(),
    }),
  querySpans: () => Promise.resolve(emptyResult()),
  getTrace: unused,
  percentileOf: unused,
};

function renderShell(hash: string, ds: DataSource = dataSource): void {
  window.location.hash = hash;
  render(
    <ThemeProvider>
      <Shell dataSource={ds} history={createHashHistory(window)} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('sidebar', () => {
  test('renders Dashboards, Logs, Metrics, Traces in order with Traces > Explorer as the ink pill', () => {
    renderShell('#/traces');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const headings = within(nav)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['Dashboards', 'Logs', 'Metrics', 'Traces']);
    const traces = within(nav).getByRole('region', { name: 'Traces' });
    const explorer = within(traces).getByRole('link', { name: 'Explorer' });
    expect(explorer.getAttribute('aria-current')).toBe('page');
    expect(explorer.getAttribute('data-selected')).toBe('true');
    expect(
      within(nav)
        .getAllByRole('link')
        .filter((l) => l.getAttribute('aria-current') === 'page'),
    ).toHaveLength(1);
    expect(within(traces).getByRole('link', { name: 'Services' }).getAttribute('href')).toBe(
      '#/traces/services',
    );
  });

  test('defaults to #/traces and shows the run card with start, duration and totals', () => {
    renderShell('');
    expect(window.location.hash.startsWith('#/traces')).toBe(true);
    const card = screen.getByRole('region', { name: 'Run' });
    expect(within(card).getByText('Checkout load test')).toBeTruthy();
    expect(within(card).getByText(/2023-11-14T22:13:20\.000Z/)).toBeTruthy();
    expect(within(card).getByText(/36000 s/)).toBeTruthy();
    expect(within(card).getByText('1234')).toBeTruthy();
    expect(within(card).getByText('56')).toBeTruthy();
    expect(within(card).getByText('7')).toBeTruthy();
  });

  test('Patterns and Catalog are labelled, non-link items', () => {
    renderShell('#/logs');
    expect(screen.queryByRole('link', { name: /Patterns/ })).toBeNull();
    expect(screen.getByText('Patterns').closest('[aria-disabled="true"]')).not.toBeNull();
  });
});

describe('routes', () => {
  test('logs, metrics and dashboards show a labelled count from the manifest totals', () => {
    renderShell('#/logs');
    expect(screen.getByRole('heading', { name: 'Logs', level: 1 })).toBeTruthy();
    expect(screen.getByText('Coming in a later release')).toBeTruthy();
    expect(screen.getByLabelText('Log records in this run').textContent).toBe('56');
    cleanup();
    renderShell('#/metrics');
    expect(screen.getByLabelText('Metric data points in this run').textContent).toBe('7');
    cleanup();
    renderShell('#/dashboards');
    expect(screen.getByLabelText('Spans in this run').textContent).toBe('1234');
  });

  test('traces explorer and services have labelled placeholder pages', () => {
    renderShell('#/traces');
    expect(screen.getByRole('heading', { name: 'Traces Explorer', level: 1 })).toBeTruthy();
    cleanup();
    renderShell('#/traces/services');
    expect(screen.getByRole('heading', { name: 'Services', level: 1 })).toBeTruthy();
  });

  test('an unknown route says so and names it', () => {
    renderShell('#/nope');
    expect(screen.getByText('/nope')).toBeTruthy();
  });
});

describe('shortcuts in the shell', () => {
  test('g l navigates to #/logs', async () => {
    const user = userEvent.setup();
    renderShell('#/traces');
    await user.keyboard('gl');
    expect(window.location.hash).toBe('#/logs');
  });

  test('typing g inside the query input does nothing', async () => {
    const user = userEvent.setup();
    renderShell('#/traces');
    const input = screen.getByRole('searchbox', { name: 'Search' });
    await user.click(input);
    await user.keyboard('gl');
    expect(window.location.hash.startsWith('#/traces')).toBe(true);
    expect((input as HTMLInputElement).value).toBe('gl');
  });

  test('/ focuses the query bar and ? opens the shortcut help dialog', async () => {
    const user = userEvent.setup();
    renderShell('#/traces');
    await user.keyboard('/');
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search' }));
    await user.keyboard('{Escape}');
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('g l')).toBeTruthy();
  });
});

describe('time range', () => {
  test('previous shifts a 1 h window by exactly 1 h and next shifts it back', async () => {
    const user = userEvent.setup();
    renderShell(`#/traces?t=${5 * HOUR}~${6 * HOUR}`);
    await user.click(screen.getByRole('button', { name: 'Previous window' }));
    expect(window.location.hash).toBe(`#/traces?t=${4 * HOUR}~${5 * HOUR}`);
    await user.click(screen.getByRole('button', { name: 'Next window' }));
    expect(window.location.hash).toBe(`#/traces?t=${5 * HOUR}~${6 * HOUR}`);
  });

  test('presets anchor at run end, zoom out doubles, Entire run clears, and the absolute range shows', async () => {
    const user = userEvent.setup();
    renderShell('#/traces');
    const entire = screen.getByRole('button', { name: 'Entire run' });
    expect(entire.getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: '1h' }));
    expect(window.location.hash).toBe(`#/traces?t=${9 * HOUR}~${10 * HOUR}`);
    expect(screen.getByLabelText('Absolute range').textContent).toContain('2023-11-15T07:13:20.000Z');
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(window.location.hash).toBe(`#/traces?t=${8 * HOUR}~${10 * HOUR}`);
    await user.click(screen.getByRole('button', { name: '15m' }));
    expect(window.location.hash).toBe(`#/traces?t=${10 * HOUR - 900_000_000_000}~${10 * HOUR}`);
    await user.click(entire);
    expect(window.location.hash).toBe('#/traces');
  });
});

describe('chrome', () => {
  test('Copy link writes the URL to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderShell('#/traces');
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });

  test('Copy link falls back to a selection dialog when the clipboard is unavailable', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    renderShell('#/traces');
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    const dialog = await screen.findByRole('dialog', { name: 'Copy link' });
    expect((within(dialog).getByRole('textbox') as HTMLInputElement).value).toBe(window.location.href);
  });

  test('the Export menu opens with a disabled slot on pages without exports and the formats on Traces', async () => {
    const user = userEvent.setup();
    renderShell('#/traces');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect((await screen.findAllByRole('menuitem')).map((i) => i.textContent)).toEqual([
      'Export CSV',
      'Export JSON',
      'Export OTLP JSON',
    ]);
    cleanup();
    renderShell('#/logs');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    const item = await screen.findByRole('menuitem', { name: /Nothing to export on this page/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
  });

  test('invalid URL params are reported in a dismissible banner and removed from the URL', async () => {
    const user = userEvent.setup();
    renderShell('#/traces?mode=bogus&text=hello');
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('mode');
    expect(window.location.hash).toBe('#/traces?text=hello');
    await user.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('the theme toggle switches the document theme', async () => {
    const user = userEvent.setup();
    renderShell('#/traces');
    await user.click(screen.getByRole('button', { name: 'Dark theme' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('App loading', () => {
  test('shows a loading state, then the shell', async () => {
    window.location.hash = '#/traces';
    render(
      <ThemeProvider>
        <App load={() => Promise.resolve(dataSource)} history={createHashHistory(window)} />
      </ThemeProvider>,
    );
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeTruthy();
  });

  test('a load failure renders a designed error naming the failing path', async () => {
    const failure = new OtelHtmlError('invalid-report', {
      path: 'data/rollups/spans.js',
      expected: 'a data script that registers its payload',
      actual: 'script failed to load',
    });
    render(
      <ThemeProvider>
        <App load={() => Promise.reject(failure)} history={createHashHistory(window)} />
      </ThemeProvider>,
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('data/rollups/spans.js');
    expect(within(alert).getByRole('heading', { name: /could not be loaded/ })).toBeTruthy();
  });
});

const RUN = { start: 0, end: 10 * HOUR };
const TRACE = 'a'.repeat(32);

describe('stepWindow bounds (disabled, never clamped, in both directions)', () => {
  test('returns null when the step would leave the run', () => {
    expect(stepWindow({ start: 9 * HOUR, end: 10 * HOUR }, RUN, 1)).toBeNull();
    expect(stepWindow({ start: 0, end: HOUR }, RUN, -1)).toBeNull();
    expect(stepWindow({ start: 8 * HOUR, end: 9 * HOUR }, RUN, 1)).toEqual({
      start: 9 * HOUR,
      end: 10 * HOUR,
    });
    expect(stepWindow({ start: HOUR, end: 2 * HOUR }, RUN, -1)).toEqual({ start: 0, end: HOUR });
  });

  test('Next is disabled at the run end and Previous at the run start', () => {
    renderShell(`#/traces?t=${9 * HOUR}~${10 * HOUR}`);
    expect((screen.getByRole('button', { name: 'Next window' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Previous window' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    cleanup();
    renderShell(`#/traces?t=0~${HOUR}`);
    expect((screen.getByRole('button', { name: 'Previous window' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Next window' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('navigation carries the selection', () => {
  const t = `t=${5 * HOUR}~${6 * HOUR}`;

  test('sidebar links and g-shortcuts keep the query, and back/forward re-sync the store from the URL', async () => {
    const user = userEvent.setup();
    renderShell(`#/traces?${t}`);
    const range = (): string => screen.getByLabelText('Absolute range').textContent ?? '';
    const before = range();
    await user.click(
      within(screen.getByRole('region', { name: 'Logs' })).getByRole('link', { name: 'Explorer' }),
    );
    expect(window.location.hash).toBe(`#/logs?${t}`);
    expect(range()).toBe(before);
    await user.click(screen.getByRole('button', { name: '15m' }));
    const narrowed = `t=${10 * HOUR - 900_000_000_000}~${10 * HOUR}`;
    expect(window.location.hash).toBe(`#/logs?${narrowed}`);
    await user.keyboard('gt');
    expect(window.location.hash).toBe(`#/traces?${narrowed}`);
    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe(`#/logs?${narrowed}`));
    window.history.back();
    await waitFor(() => expect(window.location.hash).toBe(`#/traces?${t}`));
    await waitFor(() => expect(range()).toBe(before));
    expect(screen.getByRole('heading', { name: 'Traces Explorer', level: 1 })).toBeTruthy();
  });
});

describe('overlays own the keyboard', () => {
  test('Escape that closes the Export menu does not clear the selected trace', async () => {
    const user = userEvent.setup();
    renderShell(`#/traces?trace=${TRACE}`);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await screen.findAllByRole('menuitem');
    await user.keyboard('{Escape}');
    expect(window.location.hash).toContain(`trace=${TRACE}`);
    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));
    await user.keyboard('{Escape}');
    expect(window.location.hash).not.toContain('trace=');
  });

  test('shortcuts do not fire behind the Copy link dialog', async () => {
    const user = userEvent.setup();
    renderShell('#/traces');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    await screen.findByRole('dialog', { name: 'Copy link' });
    await user.keyboard('gl');
    expect(window.location.hash).toBe('#/traces');
  });
});

describe('full-page trace route', () => {
  const traceDs = (): DataSource => ({
    ...dataSource,
    getTrace: () =>
      Promise.resolve(detailOf([traceRow(1, null, 0, 1000, { service: 'checkout', name: 'GET /' })])),
    percentileOf: () => 91,
  });

  test('#/traces/trace/<id> shows the same panel full width, with the header facts', async () => {
    renderShell(`#/traces/trace/${TRACE_ID}`, traceDs());
    const panel = await screen.findByTestId('trace-panel');
    expect(panel.getAttribute('data-layout')).toBe('page');
    const header = await within(panel).findByTestId('trace-header');
    expect(header.textContent).toContain('checkout');
    expect(header.textContent).toContain(TRACE_ID);
    expect(within(header).getByText('p91')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Full page' })).toBeNull();
  });

  test('an invalid id in the route is a designed error naming the problem', async () => {
    renderShell('#/traces/trace/not-a-trace', traceDs());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Invalid trace link');
    expect(alert.textContent).toContain('route trace id');
  });

  test('Escape leaves the page for the explorer, and Close does the same', async () => {
    const user = userEvent.setup();
    renderShell(`#/traces/trace/${TRACE_ID}?text=abc`, traceDs());
    await screen.findByTestId('trace-header');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(window.location.hash).toBe('#/traces?text=abc'));
  });

  test('the overlay Full page link opens the route and keeps the filters', async () => {
    const user = userEvent.setup();
    renderShell(`#/traces?text=abc&trace=${TRACE_ID}`, traceDs());
    await user.click(await screen.findByRole('link', { name: 'Full page' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/traces/trace/${TRACE_ID}?text=abc`));
    expect((await screen.findByTestId('trace-panel')).getAttribute('data-layout')).toBe('page');
  });
});
