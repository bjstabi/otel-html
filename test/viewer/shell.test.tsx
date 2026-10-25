import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Manifest } from '../../src/format/manifest.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { App } from '../../src/viewer/app.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';

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
  throw new Error('the shell must not query data yet');
}
const dataSource: DataSource = {
  manifest,
  strategy: 'eager',
  landing: unused,
  querySpans: unused,
  getTrace: unused,
  percentileOf: unused,
};

function renderShell(hash: string): void {
  window.location.hash = hash;
  render(
    <ThemeProvider>
      <Shell dataSource={dataSource} history={createHashHistory(window)} />
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

  test('the Export menu opens with a disabled slot to be filled per page', async () => {
    const user = userEvent.setup();
    renderShell('#/traces');
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
