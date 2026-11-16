import { Tooltip } from '@base-ui/react/tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FacetCounts } from '../../src/rollups/facets.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { SpanQuery, SpanQueryResult, SpanRow, TraceRow } from '../../src/viewer/data/results.js';
import { type GoTo, GoToContext } from '../../src/viewer/shell/go-to.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { TracesExplorer } from '../../src/viewer/traces/explorer.js';
import { manifestV4 } from './v4-manifest.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const LIST_CAP = 1000;

function spans(prefix: string, n: number): SpanRow[] {
  return Array.from(
    { length: n },
    (_, i) =>
      ({
        span: {
          traceId: 'aa',
          spanId: `${prefix}${i}`,
          parentSpanId: null,
          name: `${prefix}${i}`,
          kind: 2,
          start: 1000 + i,
          end: 2000 + i,
          status: { code: 1, message: '' },
          attributes: new Map(),
        },
        service: 'web',
        resource: 'r',
        durationNs: 1000,
      }) as unknown as SpanRow,
  );
}

function traces(prefix: string, n: number): TraceRow[] {
  return Array.from(
    { length: n },
    (_, i) =>
      ({
        traceId: `${prefix}${i}`,
        rootSummary: { service: 'web', name: 'root', resource: 'r' },
        start: 1000 + i,
        durationNs: 1000,
        spans: 1,
        errors: 0,
        share: [],
      }) as unknown as TraceRow,
  );
}

const CURSOR = { time: 5n, filename: 'f', row: 1n };

function page(rows: SpanQueryResult['rows'], next: SpanQueryResult['next'], total = 5000): SpanQueryResult {
  return {
    rows,
    total,
    facets: new FacetCounts(100, 50, ['service.name']),
    buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
    red: null,
    durations: { summary: null, bins: [] },
    groups: null,
    residual: null,
    tables: { resources: [], scopes: [] },
    next,
  } as SpanQueryResult;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(
  querySpans: (q: SpanQuery) => Promise<SpanQueryResult>,
  initial: Parameters<typeof createSelectionStore>[0] = {},
) {
  const calls: SpanQuery[] = [];
  const ds = {
    manifest: manifestV4(5000, LIST_CAP),
    querySpans: (q: SpanQuery) => {
      calls.push(q);
      return querySpans(q);
    },
    serviceShare: () => Promise.resolve([]),
  } as unknown as DataSource;
  const store = createSelectionStore(initial);
  render(
    <ThemeProvider>
      <SelectionProvider store={store}>
        <GoToContext.Provider value={vi.fn<GoTo>()}>
          <Tooltip.Provider>
            <TracesExplorer dataSource={ds} />
          </Tooltip.Provider>
        </GoToContext.Provider>
      </SelectionProvider>
    </ThemeProvider>,
  );
  return { store, calls };
}

const rowCount = (): number =>
  Number(screen.getByRole('grid', { name: 'Results' }).getAttribute('aria-rowcount')) - 1;

function scrollToEnd(): void {
  const grid = screen.getByRole('grid', { name: 'Results' });
  const scroller = grid.querySelectorAll('[role="rowgroup"]')[1];
  if (!(scroller instanceof HTMLElement)) throw new Error('the grid has a scroller');
  scroller.scrollTop = 36 * (rowCount() - 10);
  fireEvent.scroll(scroller);
}

describe('the Traces list pages', () => {
  test('spans: 200 at a time; scrolling appends the next page, which asks rows only', async () => {
    const { calls } = setup((q) =>
      Promise.resolve(q.cursor == null ? page(spans('a', 200), CURSOR) : page(spans('b', 200), null)),
    );
    await waitFor(() => expect(rowCount()).toBe(200));
    expect(calls[0]?.limit).toBe(200);
    expect(calls[0]?.needs).toEqual(['rows', 'facets', 'timeline', 'durations']);
    scrollToEnd();
    await waitFor(() => expect(rowCount()).toBe(400));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cursor).toEqual(CURSOR);
    expect(calls[1]?.needs).toEqual(['rows']);
    expect(screen.getByText(/^5000 spans · showing 400$/)).toBeTruthy();
  });

  test('traces mode pages the same way', async () => {
    const { calls } = setup(
      (q) =>
        Promise.resolve(q.cursor == null ? page(traces('a', 200), CURSOR) : page(traces('b', 100), null)),
      { mode: 'traces' },
    );
    await waitFor(() => expect(rowCount()).toBe(200));
    scrollToEnd();
    await waitFor(() => expect(rowCount()).toBe(300));
    expect(calls[1]?.mode).toBe('traces');
  });

  test('a filter change while a page is in flight shows only the new list', async () => {
    const late = deferred<SpanQueryResult>();
    const { store, calls } = setup((q) => {
      if (q.cursor != null) return late.promise;
      return Promise.resolve(
        q.condition === null ? page(spans('old', 200), CURSOR) : page(spans('new', 5), null, 5),
      );
    });
    await waitFor(() => expect(rowCount()).toBe(200));
    scrollToEnd();
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => store.getState().setCondition('status.code == STATUS_CODE_ERROR'));
    await waitFor(() => expect(rowCount()).toBe(5));
    await act(async () => late.resolve(page(spans('stale', 200), null)));
    expect(rowCount()).toBe(5);
  });

  test('a non-time sort is one statement of listCap rows and never pages', async () => {
    const { calls } = setup(() => Promise.resolve(page(spans('a', 60), null)), { sort: 'duration:desc' });
    await waitFor(() => expect(rowCount()).toBe(60));
    scrollToEnd();
    await act(async () => {});
    expect(calls).toHaveLength(1);
    expect(calls[0]?.limit).toBe(LIST_CAP);
  });

  test('a condition the browser evaluates is one statement of listCap rows', async () => {
    const { calls } = setup(() => Promise.resolve(page(spans('a', 60), null, 60)), {
      q: 'Len(name) > 7',
    });
    await waitFor(() => expect(rowCount()).toBe(60));
    expect(calls[0]?.limit).toBe(LIST_CAP);
  });
});
