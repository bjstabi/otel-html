import { Tooltip } from '@base-ui/react/tooltip';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import type { Manifest } from '../../src/format/manifest.js';
import { ExpHistogram } from '../../src/rollups/exp-histogram.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { RedSeries } from '../../src/rollups/red.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import type { DataSource, SpanQuery, SpanQueryResult } from '../../src/viewer/data/data-source.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { ServicesPage } from '../../src/viewer/traces/services-page.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const manifest = (spans: number): Manifest => ({
  formatVersion: 1,
  otelHtmlVersion: '0.0.0',
  title: 'run',
  epochUnixNano: '1700000000000000000',
  createdAt: '2023-11-14T22:13:20.000Z',
  updatedAt: '2023-11-14T22:13:20.000Z',
  complete: true,
  range: { start: 0, end: 1_000_000_000 },
  totals: { spans, logs: 56, metrics: 7 },
  decodedBytes: 1,
  chunks: [],
  rollups: [],
  traceShards: [],
  config: { viewer: { eagerBudgetBytes: 1, listCap: 100, theme: 'system' } },
});

function result(errors: number, partial: SpanQueryResult['partial']): SpanQueryResult {
  const facets = new FacetCounts(10, 10, ['service.name']);
  for (let i = 0; i < errors; i++) facets.add('service.name', 'web');
  return {
    rows: [],
    total: errors,
    facets,
    buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
    red: new RedSeries(8),
    partial,
  };
}

/** Windowed-like: unscanned queries find 1 error of the true 4 and report partial; scanAll finds all 4. */
function windowed(spans = 10): { ds: DataSource; calls: SpanQuery[] } {
  const calls: SpanQuery[] = [];
  const facets = new FacetCounts(10, 10, ['service.name']);
  for (let i = 0; i < 10; i++) facets.add('service.name', 'web');
  const h = new ExpHistogram();
  h.record(100);
  const ds = {
    manifest: manifest(spans),
    strategy: 'windowed',
    landing: () =>
      Promise.resolve({
        facets,
        buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
        red: new RedSeries(8),
        durations: new Map([['web\u0000GET /', h]]),
      }),
    querySpans: (q: SpanQuery) => {
      calls.push(q);
      return Promise.resolve(q.scanAll ? result(4, null) : result(1, { scanned: 2, total: 8 }));
    },
  } as unknown as DataSource;
  return { ds, calls };
}

function mount(ds: DataSource): void {
  render(
    <ThemeProvider>
      <SelectionProvider store={createSelectionStore({})}>
        <Tooltip.Provider>
          <ServicesPage dataSource={ds} />
        </Tooltip.Provider>
      </SelectionProvider>
    </ThemeProvider>,
  );
}

describe('ServicesPage', () => {
  test('a partial scan labels errors, error rate and sparkline as partial and offers Scan entire run', async () => {
    const { ds } = windowed();
    mount(ds);
    const note = await screen.findByRole('status', { name: 'Partial results' });
    expect(note.textContent).toBe('from 2 of 8 chunks · Scan entire run');
    const row = screen.getByRole('row', { name: /web/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells[1]?.textContent).toBe('≥ 1partial'); // Errors
    expect(cells[2]?.textContent).toBe('≥ 10.0%partial'); // Error rate
    expect(cells.at(-1)?.textContent).toContain('partial'); // sparkline
    expect(cells[0]?.textContent).toBe('10'); // requests stay exact
  });

  test('Scan entire run re-queries with scanAll and the cells become exact', async () => {
    const user = userEvent.setup();
    const { ds, calls } = windowed();
    mount(ds);
    await user.click(await screen.findByRole('button', { name: 'Scan entire run' }));
    await waitFor(() => expect(calls.some((q) => q.scanAll)).toBe(true));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Partial results' })).toBeNull());
    const cells = within(screen.getByRole('row', { name: /web/ })).getAllByRole('cell');
    expect(cells[1]?.textContent).toBe('4');
    expect(cells[2]?.textContent).toBe('40.0%');
    expect(calls.filter((q) => q.scanAll).every((q) => q.groupBy === null)).toBe(true);
  });

  test('a zero-span report shows the explorer empty state with the other signal counts', async () => {
    const { ds } = windowed(0);
    const empty = {
      ...ds,
      landing: () =>
        Promise.resolve({
          facets: new FacetCounts(10, 10),
          buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
          red: new RedSeries(8),
          durations: new Map(),
        }),
    } as DataSource;
    mount(empty);
    expect(await screen.findByText('This report has no spans')).toBeTruthy();
    expect(screen.getByText('56')).toBeTruthy();
  });
});
