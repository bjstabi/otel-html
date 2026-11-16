import { Tooltip } from '@base-ui/react/tooltip';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EChartsOption } from 'echarts';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseUnixNanos } from '../../src/model/ids.js';
import { createNormalizeContext, normalizeLogs } from '../../src/model/normalize.js';
import { parseOtlpJson } from '../../src/model/otlp-json.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { LOG_SEVERITY_KEYS, type LogSeverityKey } from '../../src/semconv/severity.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { LogRow } from '../../src/viewer/data/log-query.js';
import type { LogPoint, LogPointsQuery, LogQuery, LogQueryResult } from '../../src/viewer/data/results.js';
import { LogsExplorer } from '../../src/viewer/logs/explorer.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { logRecord, logsRequest, T0 } from '../../test-support/otlp-builders.js';
import { toLogEntries } from './log-entries.js';
import { manifestV4 } from './v4-manifest.js';

const charts: EChartsOption[] = [];
vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { option: EChartsOption }): null => {
    charts.push(p.option);
    return null;
  },
}));
const downloads: { blob: Blob; name: string }[] = [];
vi.mock('../../src/viewer/components/export.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/viewer/components/export.js')>()),
  downloadBlob: (blob: Blob, name: string) => downloads.push({ blob, name }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  cleanup();
  charts.length = 0;
  downloads.length = 0;
});

const epoch = parseUnixNanos(T0, 'epoch');
const LIST_CAP = 1000;

/** `n` real log rows whose bodies are `${prefix}${i}`, one microsecond apart. */
function rows(prefix: string, n: number): LogRow[] {
  const req = logsRequest(
    Array.from({ length: n }, (_, i) =>
      logRecord({
        timeUnixNano: String(BigInt(T0) + BigInt(i * 1000)),
        severityNumber: 9,
        severityText: 'INFO',
        body: { stringValue: `${prefix}${i}` },
      }),
    ),
    [],
  );
  const ctx = createNormalizeContext(epoch);
  const logs = parseOtlpJson(JSON.stringify(req), 'in.json').flatMap((r) =>
    r.signal === 'logs' ? normalizeLogs(r.request, ctx, 'in.json') : [],
  );
  const chunk = { n: 0, resources: ctx.resources.entries(), scopes: ctx.scopes.entries() };
  return toLogEntries(chunk, logs, epoch, 'test').map((e) => e.row);
}

function page(r: LogRow[], next: LogQueryResult['next'], total = 5000): LogQueryResult {
  return {
    mode: 'logs',
    rows: r,
    total,
    matched: total,
    facets: new FacetCounts(100, 50, ['service.name']),
    buckets: new TimeBuckets<LogSeverityKey>(LOG_SEVERITY_KEYS, 8),
    residual: null,
    next,
  };
}

const CURSOR = { time: 5n as unknown as bigint, filename: 'f', row: 1n };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(
  queryLogs: (q: LogQuery) => Promise<LogQueryResult>,
  initial: Parameters<typeof createSelectionStore>[0] = {},
  logPoints: (q: LogPointsQuery) => Promise<readonly LogPoint[]> = () => Promise.resolve([]),
) {
  const calls: LogQuery[] = [];
  const pointCalls: LogPointsQuery[] = [];
  const ds = {
    manifest: { ...manifestV4(12, LIST_CAP), totals: { spans: 12, logs: 5000, metrics: 7 } },
    epoch: BigInt(T0),
    queryLogs: (q: LogQuery) => {
      calls.push(q);
      return queryLogs(q);
    },
    logPoints: (q: LogPointsQuery) => {
      pointCalls.push(q);
      return logPoints(q);
    },
    hasTrace: () => Promise.resolve(false),
    getTrace: () => new Promise(() => {}),
    getLog: () => new Promise(() => {}),
  } as unknown as DataSource;
  const store = createSelectionStore(initial);
  render(
    <ThemeProvider>
      <SelectionProvider store={store}>
        <Tooltip.Provider>
          <LogsExplorer dataSource={ds} />
        </Tooltip.Provider>
      </SelectionProvider>
    </ThemeProvider>,
  );
  return { store, calls, pointCalls };
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

describe('the Logs list pages', () => {
  test('asks for 200 rows, and scrolling near the end appends the next page', async () => {
    const first = rows('a', 200);
    const second = rows('b', 200);
    const { calls } = setup((q) =>
      Promise.resolve(q.cursor == null ? page(first, CURSOR) : page(second, null)),
    );
    await waitFor(() => expect(rowCount()).toBe(200));
    expect(calls[0]?.limit).toBe(200);
    expect(calls[0]?.needs).toEqual(['rows', 'total', 'facets', 'timeline']);
    expect(calls).toHaveLength(1);
    scrollToEnd();
    await waitFor(() => expect(rowCount()).toBe(400));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cursor).toEqual(CURSOR);
    expect(calls[1]?.needs).toEqual(['rows']);
    expect(calls[1]?.limit).toBe(200);
    expect(screen.getByText(/^5000 logs · showing 400$/)).toBeTruthy();
  });

  test('stops asking when the page says there is no next', async () => {
    const { calls } = setup(() => Promise.resolve(page(rows('a', 60), null, 60)));
    await waitFor(() => expect(rowCount()).toBe(60));
    scrollToEnd();
    expect(calls).toHaveLength(1);
  });

  test('stops at listCap: no page is asked once the rows held reach it', async () => {
    const big = rows('a', 200);
    const { calls } = setup(() => Promise.resolve(page(big, CURSOR)), {});
    for (let i = 1; i <= 8; i++) {
      await waitFor(() => expect(rowCount()).toBe(Math.min(200 * i, LIST_CAP)));
      scrollToEnd();
    }
    await waitFor(() => expect(rowCount()).toBe(LIST_CAP));
    scrollToEnd();
    await act(async () => {});
    expect(calls).toHaveLength(LIST_CAP / 200);
  });

  test('a filter change while a page is in flight shows only the new list', async () => {
    const late = deferred<LogQueryResult>();
    const { store, calls } = setup((q) => {
      if (q.cursor != null) return late.promise;
      return Promise.resolve(
        q.condition === null ? page(rows('old', 200), CURSOR) : page(rows('new', 5), null, 5),
      );
    });
    await waitFor(() => expect(rowCount()).toBe(200));
    scrollToEnd();
    await waitFor(() => expect(calls).toHaveLength(2));
    act(() => store.getState().setCondition('severity_number >= 17'));
    await waitFor(() => expect(rowCount()).toBe(5));
    await act(async () => late.resolve(page(rows('stale', 200), null)));
    expect(rowCount()).toBe(5);
    expect(document.body.textContent).toContain('new0');
    expect(document.body.textContent).not.toContain('stale');
    expect(document.body.textContent).not.toContain('old');
  });

  test('a non-time sort is one statement of listCap rows and never pages', async () => {
    const { calls } = setup(() => Promise.resolve(page(rows('a', 60), null, 5000)), {
      sort: 'severity:desc',
    });
    await waitFor(() => expect(rowCount()).toBe(60));
    scrollToEnd();
    await act(async () => {});
    expect(calls).toHaveLength(1);
    expect(calls[0]?.limit).toBe(LIST_CAP);
  });

  test('a condition the browser evaluates is one statement of listCap rows', async () => {
    const { calls } = setup(() => Promise.resolve(page(rows('a', 60), null, 60)), {
      q: 'Len(body.string) > 7',
    });
    await waitFor(() => expect(rowCount()).toBe(60));
    expect(calls[0]?.limit).toBe(LIST_CAP);
  });

  test('traces mode is one statement of listCap rows', async () => {
    const { calls } = setup(
      () =>
        Promise.resolve({
          ...page([], null, 0),
          mode: 'traces',
          rows: [],
        } as LogQueryResult),
      { mode: 'traces' },
    );
    await act(async () => {});
    expect(calls[0]?.limit).toBe(LIST_CAP);
  });
});

describe('the Logs scatter', () => {
  test('is drawn from logPoints of up to listCap logs, run only while the scatter shows', async () => {
    const pts: LogPoint[] = Array.from({ length: 300 }, (_, i) => ({ time: i, severity: 9 }));
    const { calls, pointCalls } = setup(
      () => Promise.resolve(page(rows('a', 200), CURSOR)),
      { view: 'scatter' },
      () => Promise.resolve(pts),
    );
    await waitFor(() => {
      const last = charts.at(-1) as { series?: { data: unknown[] }[] } | undefined;
      expect(last?.series?.reduce((n, s) => n + s.data.length, 0)).toBe(300);
    });
    expect(pointCalls).toHaveLength(1);
    expect(pointCalls[0]?.limit).toBe(LIST_CAP);
    expect(pointCalls[0]?.sort).toEqual({ column: 'time', dir: 'desc' });
    // the list's own statements never ask for the scatter's rows
    expect(calls.every((c) => c.limit !== LIST_CAP)).toBe(true);
  });

  test('the list view never runs it', async () => {
    const { pointCalls } = setup(() => Promise.resolve(page(rows('a', 200), CURSOR)));
    await waitFor(() => expect(rowCount()).toBe(200));
    expect(pointCalls).toHaveLength(0);
  });
});

describe('exporting the Logs list', () => {
  const csvRows = async (): Promise<number> =>
    ((await downloads[0]?.blob.text()) ?? '').split('\n').filter((l) => l !== '').length - 1;

  test('writes the list up to listCap, from one statement of its own, not the pages loaded', async () => {
    const first = rows('a', 200);
    const all = rows('x', LIST_CAP);
    const { calls } = setup((q) =>
      Promise.resolve(q.limit === LIST_CAP ? page(all, null) : page(first, CURSOR)),
    );
    await waitFor(() => expect(rowCount()).toBe(200));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export CSV' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(await csvRows()).toBe(LIST_CAP);
    const own = calls.at(-1);
    expect(own?.limit).toBe(LIST_CAP);
    expect(own?.cursor).toBeNull();
    expect(own?.needs).toEqual(['rows']);
  });

  test('a list that is already whole is written as it is, with no further statement', async () => {
    const { calls } = setup(() => Promise.resolve(page(rows('a', 60), null, 60)));
    await waitFor(() => expect(rowCount()).toBe(60));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export CSV' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(await csvRows()).toBe(60);
    expect(calls).toHaveLength(1);
  });
});
