import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { metricsSource } from './metrics-fixture.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    const gauge = (await screen.findByText('queue.depth')).closest('[role="row"]') as HTMLElement | null;
    expect(gauge).not.toBeNull();
    if (gauge === null) return;
    const g = within(gauge);
    expect(g.getByText('GAUGE')).toBeTruthy();
    expect(g.getByText('test-scope')).toBeTruthy();
    expect(g.getByText('host, k')).toBeTruthy();
    expect(g.getByText('2')).toBeTruthy();
    expect(gauge.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('rpc.latency')).toBeTruthy();
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
