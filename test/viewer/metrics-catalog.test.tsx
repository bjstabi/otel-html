import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { metricsSource } from './metrics-fixture.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));

const source = metricsSource();

beforeEach(() => {
  window.location.hash = '#/metrics/catalog';
});
afterEach(cleanup);

function open(): void {
  render(
    <ThemeProvider>
      <Shell dataSource={source()} history={createHashHistory(window)} />
    </ThemeProvider>,
  );
}

describe('the Metrics Catalog over format 4', () => {
  test('lists every metric with type, unit, temporality, scope, attribute keys, series and a sparkline', async () => {
    open();
    const row = (await screen.findByText('queue.depth')).closest('[role="row"]') as HTMLElement | null;
    expect(row).not.toBeNull();
    if (row === null) return;
    // columns: metric, type, unit, temporality, scope, attributes, series, over the run, explore
    const cells = within(row).getAllByRole('gridcell');
    expect(cells.map((c) => c.textContent)).toEqual([
      'queue.depth',
      'GAUGE',
      'ms',
      'unspecified',
      'test-scope',
      'host, k',
      '2',
      '',
      'Explore →',
    ]);
    expect(cells[7]?.querySelector('svg polyline, svg circle')).not.toBeNull();
    expect(screen.getByText('SUMMARY')).toBeTruthy();
  });

  test('filters by text', async () => {
    open();
    await screen.findByText('queue.depth');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter metrics' }), 'rpc');
    await waitFor(() => expect(screen.queryByText('queue.depth')).toBeNull());
    expect(screen.getByText('rpc.latency')).toBeTruthy();
  });

  test('a row click opens the Explorer on the metric with the kind default show', async () => {
    open();
    await userEvent.click(await screen.findByText('queue.depth'));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/metrics\?/));
    const m = parseUrlState(window.location.hash.split('?')[1] ?? '').state.m;
    expect(m?.queries[0]).toMatchObject({ metric: 'queue.depth', show: 'avg' });
  });
});

describe('a summary row', () => {
  test('opens the Explorer with the qmax placeholder as the show', async () => {
    open();
    await userEvent.click(await screen.findByText('rpc.latency'));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/metrics\?/));
    const m = parseUrlState(window.location.hash.split('?')[1] ?? '').state.m;
    expect(m?.queries[0]).toMatchObject({ metric: 'rpc.latency', show: 'qmax' });
  });
});
