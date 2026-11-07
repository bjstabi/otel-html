import { Tooltip } from '@base-ui/react/tooltip';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { ServiceStats, ServicesResult } from '../../src/viewer/data/results.js';
import { GoToContext } from '../../src/viewer/shell/go-to.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { ServicesPage } from '../../src/viewer/traces/services-page.js';
import { manifestV4 } from './v4-manifest.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

function stats(service: string, requests: number, errors: number): ServiceStats {
  const buckets = new TimeBuckets(['count'], 4);
  buckets.add(0 as RelNanos, 'count');
  return { service, requests, errors, p50: 1000, p95: 2000, p99: 3000, max: 4000, buckets };
}

type ServicesCall = [{ window: unknown; condition: string | null; limit: number }, AbortSignal | undefined];

function source(
  result: ServicesResult,
  spans = 10,
): { ds: DataSource; services: ReturnType<typeof vi.fn<(...a: ServicesCall) => Promise<ServicesResult>>> } {
  const services = vi.fn<(...a: ServicesCall) => Promise<ServicesResult>>(() => Promise.resolve(result));
  return { ds: { manifest: manifestV4(spans), services } as unknown as DataSource, services };
}

function mount(ds: DataSource, window: { start: number; end: number } | null = null): void {
  const store = createSelectionStore({});
  if (window !== null) store.getState().setWindow(window);
  render(
    <ThemeProvider>
      <SelectionProvider store={store}>
        <GoToContext.Provider value={() => {}}>
          <Tooltip.Provider>
            <ServicesPage dataSource={ds} />
          </Tooltip.Provider>
        </GoToContext.Provider>
      </SelectionProvider>
    </ThemeProvider>,
  );
}

describe('ServicesPage', () => {
  test('one services call, exact figures, no partial marks and no scan button', async () => {
    const { ds, services } = source({ services: [stats('web', 10, 4), stats('db', 5, 0)], total: 2 });
    mount(ds);
    const row = await screen.findByRole('row', { name: /web/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells.map((c) => c.textContent).slice(0, 3)).toEqual(['10', '4', '40.0%']);
    expect(within(screen.getByRole('row', { name: /db/ })).getAllByRole('cell')[1]?.textContent).toBe('0');
    expect(services).toHaveBeenCalledTimes(1);
    expect(services.mock.calls[0]?.[0]).toEqual({ window: null, condition: null, limit: 50 });
    expect(screen.queryByText(/partial/i)).toBeNull();
    expect(screen.queryByText('≥', { exact: false })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Scan entire run' })).toBeNull();
  });

  test('the selected time window is the query window', async () => {
    const { ds, services } = source({ services: [stats('web', 1, 0)], total: 1 });
    mount(ds, { start: 5, end: 9 });
    await screen.findByRole('row', { name: /web/ });
    expect(services.mock.calls[0]?.[0].window).toEqual({ start: 5, end: 9 });
  });

  test('more services than the limit says the list is the busiest 50', async () => {
    const { ds } = source({ services: [stats('web', 1, 0)], total: 51 });
    mount(ds);
    expect(await screen.findByText('Showing the 50 busiest services.')).toBeTruthy();
  });

  test('a failed query shows the message', async () => {
    const ds = {
      manifest: manifestV4(10),
      services: () => Promise.reject(new Error('the engine stopped')),
    } as unknown as DataSource;
    mount(ds);
    expect(await screen.findByText('the engine stopped')).toBeTruthy();
  });

  test('unmounting aborts the in-flight query', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const ds = {
      manifest: manifestV4(10),
      services: (_o: unknown, signal?: AbortSignal) => {
        signals.push(signal);
        return new Promise<ServicesResult>(() => undefined);
      },
    } as unknown as DataSource;
    mount(ds);
    await waitFor(() => expect(signals).toHaveLength(1));
    cleanup();
    expect(signals[0]?.aborted).toBe(true);
  });

  test('a zero-span report shows the explorer empty state with the other signal counts', async () => {
    const { ds } = source({ services: [], total: 0 }, 0);
    mount(ds);
    expect(await screen.findByText('This report has no spans')).toBeTruthy();
    expect(screen.getByText('56')).toBeTruthy();
  });

  test('no services in a window of a report that has spans says so instead', async () => {
    const { ds } = source({ services: [], total: 0 });
    mount(ds, { start: 1, end: 2 });
    expect(await screen.findByText('No spans in the selected time range.')).toBeTruthy();
    expect(screen.queryByText('This report has no spans')).toBeNull();
  });
});
