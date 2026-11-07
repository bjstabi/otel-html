import { Tooltip } from '@base-ui/react/tooltip';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FacetCounts } from '../../src/rollups/facets.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { formatDuration } from '../../src/semconv/formatters.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type {
  DurationBin,
  SpanQuery,
  SpanQueryResult,
  SpanRow,
  TraceRow,
} from '../../src/viewer/data/results.js';
import { type GoTo, GoToContext } from '../../src/viewer/shell/go-to.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { TracesExplorer } from '../../src/viewer/traces/explorer.js';
import { durationAxis } from '../../src/viewer/traces/views.js';
import { manifestV4 } from './v4-manifest.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const HOSTILE = '</script><img src=x onerror=alert(1)> ';

function row(name: string, service: string, dur: number, id: string): SpanRow {
  return {
    span: {
      traceId: 'aa',
      spanId: id,
      parentSpanId: null,
      name,
      kind: 2,
      start: 1000,
      end: 1000 + dur,
      status: { code: 1, message: '' },
      attributes: new Map(),
    },
    service,
    resource: `res-${id}`,
    durationNs: dur,
  } as unknown as SpanRow;
}

/** The exact duration distribution the engine returns for these durations (24 log-spaced bins over min..max). */
function durationsOf(
  durs: readonly number[],
  given?: readonly { fromNs: number; toNs: number }[],
): SpanQueryResult['durations'] {
  if (durs.length === 0) return { summary: null, bins: [] };
  const min = Math.min(...durs);
  const max = Math.max(...durs);
  const edges = durationAxis([{ durationNs: min }, { durationNs: max }], 24);
  const bins: DurationBin[] = (
    given ?? edges.slice(0, -1).map((from, i) => ({ fromNs: from, toNs: edges[i + 1] ?? from }))
  ).map((b) => ({ ...b, count: 0 }));
  for (const d of durs) {
    let i = 0;
    while (i < bins.length - 1 && d >= (bins[i]?.toNs ?? Number.POSITIVE_INFINITY)) i++;
    const bin = bins[i];
    if (bin !== undefined) bin.count++;
  }
  const sum = durs.reduce((a, b) => a + b, 0);
  return { summary: { count: durs.length, min, max, sum, p50: min, p95: max, p99: max }, bins };
}

function resultOf(rows: SpanRow[], over: Partial<SpanQueryResult> = {}): SpanQueryResult {
  const facets = new FacetCounts(100, 50, ['service.name', 'status.code']);
  for (const r of rows) facets.add('service.name', r.service);
  return {
    rows,
    total: rows.length,
    facets,
    buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
    red: {
      startNs: 0,
      widthNs: 1,
      counts: [rows.length],
      errors: [0],
      p50: [null],
      p95: [null],
      p99: [null],
      max: [null],
    },
    durations: durationsOf(rows.map((r) => r.durationNs)),
    groups: null,
    residual: null,
    tables: { resources: [], scopes: [] },
    ...over,
  };
}

function setup(
  querySpans: DataSource['querySpans'],
  spans = 10,
  initial: Parameters<typeof createSelectionStore>[0] = {},
  extra: Partial<DataSource> = {},
) {
  const ds = { manifest: manifestV4(spans), querySpans, ...extra } as unknown as DataSource;
  const store = createSelectionStore(initial);
  const goTo = vi.fn<GoTo>();
  render(
    <ThemeProvider>
      <SelectionProvider store={store}>
        <GoToContext.Provider value={goTo}>
          <Tooltip.Provider>
            <TracesExplorer dataSource={ds} />
          </Tooltip.Provider>
        </GoToContext.Provider>
      </SelectionProvider>
    </ThemeProvider>,
  );
  return { store, goTo };
}

describe('TracesExplorer', () => {
  test('a zero-span report says so and counts the other signals', () => {
    const querySpans = vi.fn();
    setup(querySpans, 0);
    expect(screen.getByText('This report has no spans')).toBeTruthy();
    expect(screen.getByText('56')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(querySpans).not.toHaveBeenCalled();
  });

  test('a zero-span report with logs links to the Logs Explorer through the carry-over rule', async () => {
    const user = userEvent.setup();
    const { goTo } = setup(vi.fn(), 0);
    await user.click(screen.getByRole('button', { name: 'Open the Logs Explorer' }));
    expect(goTo).toHaveBeenCalledWith('logs', '/logs');
  });

  test('no match shows "No spans match" and Clear filters clears condition, text and window', async () => {
    const user = userEvent.setup();
    const { store } = setup(() => Promise.resolve(resultOf([])), 10, {
      q: 'status.code == STATUS_CODE_ERROR',
      text: 'zzz',
    });
    const empty = (await screen.findByText('No spans match')).closest('section');
    if (empty === null) throw new Error('the empty state is a section');
    await user.click(within(empty).getByRole('button', { name: 'Clear filters' }));
    expect(store.getState().condition).toBeNull();
    expect(store.getState().text).toBe('');
  });

  test('it asks for rows, facets, timeline and durations together, with a signal and no progress callback', async () => {
    const querySpans = vi.fn<DataSource['querySpans']>(() =>
      Promise.resolve(resultOf([row('a', 's', 5, 's1')])),
    );
    setup(querySpans);
    await screen.findByRole('grid', { name: 'Results' });
    const [q, signal, ...rest] = querySpans.mock.calls[0] ?? [];
    expect(q?.needs).toEqual(['rows', 'facets', 'timeline', 'durations']);
    expect(q?.measureBy).toBeNull();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(rest).toEqual([]);
  });

  test('a residual condition says it was evaluated in the browser; an ordinary result says nothing', async () => {
    setup(() => Promise.resolve(resultOf([row('a', 's', 5, 's1')], { residual: 'Len(name) > 7' })));
    const note = await screen.findByRole('status', { name: 'Evaluated in the browser' });
    expect(note.textContent).toBe('Evaluated in the browser: Len(name) > 7');
    cleanup();
    setup(() => Promise.resolve(resultOf([row('a', 's', 5, 's1')])));
    await screen.findByRole('grid', { name: 'Results' });
    expect(screen.queryByRole('status', { name: 'Evaluated in the browser' })).toBeNull();
    expect(screen.queryByText(/Scan entire run|chunks/)).toBeNull();
  });

  test('a failing query renders a designed error with its message', async () => {
    setup(() => Promise.reject(new Error('partitions/000003.parquet: failed to load')));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The query could not run')).toBeTruthy();
    expect(alert.textContent).toContain('partitions/000003.parquet: failed to load');
  });

  test('the query never groups in the data layer', async () => {
    const calls: SpanQuery[] = [];
    setup(
      (q) => {
        calls.push(q);
        return Promise.resolve(resultOf([]));
      },
      10,
      { group: 'host.name', view: 'pie' },
    );
    await screen.findByText('No spans match');
    expect(calls.every((q) => q.groupBy === null)).toBe(true);
  });

  test('Group by is disabled with a stated reason when the view does not use it', async () => {
    setup(() => Promise.resolve(resultOf([row('a', 's', 5, 's1')])));
    const select = await screen.findByLabelText('Group by');
    expect((select as HTMLSelectElement).disabled).toBe(true);
    expect(select.getAttribute('title')).toMatch(/List view/);
  });

  test('Group by is enabled in the Table view and its title no longer says the view does not use it', async () => {
    setup(() => Promise.resolve(resultOf([row('a', 's', 5, 's1')])), 10, { view: 'table' });
    const select = (await screen.findByLabelText('Group by')) as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(select.getAttribute('title')).toBeNull();
    expect(screen.queryByText(/not used by the current view/)).toBeNull();
  });

  test('Group by in the Table view changes the grouping key of the table', async () => {
    const user = userEvent.setup();
    const r = resultOf([row('a', 'svc-1', 5, 's1'), row('b', 'svc-2', 6, 's2')]);
    r.facets.add('host.name', 'host-x');
    r.facets.add('host.name', 'host-y');
    setup(() => Promise.resolve(r), 10, { view: 'table' });
    const select = (await screen.findByLabelText('Group by')) as HTMLSelectElement;
    expect(screen.getByRole('table', { name: 'Spans grouped by service.name' })).toBeTruthy();
    await user.selectOptions(select, 'host.name');
    const table = screen.getByRole('table', { name: 'Spans grouped by host.name' });
    expect(within(table).getByText('host-x')).toBeTruthy();
    expect(within(table).queryByText('svc-1')).toBeNull();
  });

  test('the Table view keeps a real group named Other apart from the remainder', async () => {
    const r = resultOf([]);
    for (let i = 0; i < 3; i++) r.facets.add('service.name', 'Other');
    r.facets.add('service.name', 'b');
    setup(() => Promise.resolve({ ...r, rows: [row('a', 'Other', 5, 's1')], total: 4 }), 10, {
      view: 'table',
    });
    const table = await screen.findByRole('table', { name: 'Spans grouped by service.name' });
    expect(within(table).getByText('Other (value)')).toBeTruthy();
  });

  test('the duration facet counts every matching span, not only the listed rows', async () => {
    const rows = [row('a', 's', 5, 's1'), row('b', 's', 50, 's2')];
    const durations = durationsOf([
      ...rows.map((r) => r.durationNs),
      ...Array.from({ length: 38 }, () => 20),
    ]);
    setup(() => Promise.resolve({ ...resultOf(rows), total: 40, durations }));
    await screen.findByRole('grid', { name: 'Results' });
    const counts = [...document.querySelectorAll('[data-bin]')].map((b) =>
      Number(/: (\d+)$/.exec(b.getAttribute('title') ?? '')?.[1]),
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(40);
    expect(screen.queryByTestId('duration-bins-note')).toBeNull();
    expect(screen.queryByText(/Duration distribution is from the first/)).toBeNull();
  });

  test('the RED strip shows the exact quantiles of the duration summary', async () => {
    const rows = [row('a', 's', 5000, 's1')];
    setup(() =>
      Promise.resolve(
        resultOf(rows, {
          durations: {
            summary: { count: 1, min: 5000, max: 9000, sum: 14000, p50: 6000, p95: 8000, p99: 8500 },
            bins: [],
          },
        }),
      ),
    );
    const strip = await screen.findByRole('region', { name: 'Requests, errors and latency' });
    expect(strip.textContent).toContain(formatDuration(6000));
    expect(strip.textContent).toContain(formatDuration(9000));
  });

  test('the service share cell loads per row, for the trace of that row', async () => {
    const serviceShare = vi.fn((id: string) =>
      Promise.resolve(
        id === 't1'
          ? [
              { service: 'web', ns: 30 },
              { service: 'db', ns: 10 },
            ]
          : [],
      ),
    );
    const trace = (id: string): TraceRow => ({
      traceId: id as TraceRow['traceId'],
      rootSummary: { service: 'web', name: 'GET /', resource: 'GET /' },
      start: 10,
      durationNs: 40,
      spans: 3,
      errors: 0,
    });
    setup(
      () => Promise.resolve({ ...resultOf([]), rows: [trace('t1'), trace('t2')], total: 2 }),
      10,
      { mode: 'traces' },
      { serviceShare: serviceShare as unknown as DataSource['serviceShare'] },
    );
    const bar = await screen.findByRole('img', { name: /web .*, db / });
    expect(bar).toBeTruthy();
    await waitFor(() => expect(serviceShare).toHaveBeenCalledTimes(2));
    expect(serviceShare.mock.calls.map((c) => c[0]).sort()).toEqual(['t1', 't2']);
    expect(screen.queryByText('partial')).toBeNull();
  });

  test('export after a failed query says the query failed, not that one is running', async () => {
    const user = userEvent.setup();
    setup(() => Promise.reject(new Error('boom: chunk 3')));
    await screen.findByText('The query could not run');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export CSV' }));
    const alert = await screen.findByText('The export failed');
    expect(alert.parentElement?.textContent).toContain('the last query failed: boom: chunk 3');
  });

  test('hostile names render as text only', async () => {
    setup(() => Promise.resolve(resultOf([row(HOSTILE, HOSTILE, 5, 's1')])));
    await screen.findByRole('grid', { name: 'Results' });
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain(HOSTILE);
  });

  test('clicking the Duration header stores the sort in the selection', async () => {
    const user = userEvent.setup();
    const { store } = setup(() => Promise.resolve(resultOf([row('a', 's', 5, 's1')])));
    await user.click(await screen.findByRole('button', { name: /Duration/ }));
    expect(store.getState().sort).toBe('duration:desc');
  });

  describe('Copy as dashboard widget', () => {
    test('copies the view as YAML', async () => {
      const user = userEvent.setup();
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      setup(() => Promise.resolve(resultOf([row('a', 's', 5, 's1')])), 10, { q: 'status.code == 2' });
      await screen.findByRole('grid', { name: 'Results' });
      await user.click(screen.getByRole('button', { name: 'Export' }));
      await user.click(await screen.findByRole('menuitem', { name: /Copy as dashboard widget/ }));
      await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
      const yaml = String((writeText.mock.calls[0] as unknown[])[0]);
      expect(yaml).toContain('type: traces');
      expect(yaml).toContain('query: status.code == 2');
      expect(yaml).toContain('w: 7');
    });

    test('is disabled in the Pie view, with the reason', async () => {
      const user = userEvent.setup();
      setup(() => Promise.resolve(resultOf([])), 10, { view: 'pie' });
      await user.click(screen.getByRole('button', { name: 'Export' }));
      const item = await screen.findByRole('menuitem', { name: /Copy as dashboard widget/ });
      expect(item.getAttribute('aria-disabled')).toBe('true');
      expect(item.textContent).toContain('Only the List, Top list and Table views can become widgets');
    });
  });
});

describe('TracesExplorer duration facet', () => {
  const DUR = 'span.end_time_unix_nano - span.start_time_unix_nano';
  const ROWS = [1e3, 5e3, 2e4, 1e5, 4e5, 2e6, 9e6, 3e7, 2e8, 1e9].map((d, i) => row('s', 'svc', d, `d${i}`));
  /** A data source that applies the duration bounds in the condition like the real one. */
  const queries: SpanQuery[] = [];
  const filtering: DataSource['querySpans'] = (q) => {
    const lo = />= (\d+(?:\.\d+)?)/.exec(q.condition ?? '')?.[1];
    const hi = /<= (\d+(?:\.\d+)?)/.exec(q.condition ?? '')?.[1];
    const rows = ROWS.filter(
      (r) =>
        (lo === undefined || r.durationNs >= Number(lo)) && (hi === undefined || r.durationNs <= Number(hi)),
    );
    queries.push(q);
    // Like the engine: counts go into the caller's axis when it gives one.
    return Promise.resolve({
      ...resultOf(rows),
      durations: durationsOf(
        rows.map((r) => r.durationNs),
        q.durationAxis,
      ),
    });
  };

  const edges = durationAxis(ROWS, 24);

  test('under a duration filter the facet asks for the stored axis and every bin is exact', async () => {
    const user = userEvent.setup();
    const { store } = setup(filtering);
    const min = await screen.findByRole('slider', { name: 'Minimum duration' });
    expect(queries[0]?.durationAxis).toBeUndefined();
    await user.click(min);
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(store.getState().condition).toBe(`${DUR} >= ${edges[2]}`);
    const stored = edges.slice(0, -1).map((from, i) => ({ fromNs: from, toNs: edges[i + 1] ?? from }));
    await waitFor(() => expect(queries.at(-1)?.durationAxis).toEqual(stored));
    const kept = ROWS.filter((r) => r.durationNs >= (edges[2] ?? 0)).map((r) => r.durationNs);
    const expected = stored.map(
      (b, i) => kept.filter((d) => d >= b.fromNs && (i === stored.length - 1 || d < b.toNs)).length,
    );
    await waitFor(() => {
      const counts = [...document.querySelectorAll('[data-bin]')].map((b) =>
        Number(/: (\d+)$/.exec(b.getAttribute('title') ?? '')?.[1]),
      );
      expect(counts).toEqual(expected);
    });
  });

  test('the duration axis stays put while a duration filter is set', async () => {
    const user = userEvent.setup();
    const { store } = setup(filtering);
    const min = await screen.findByRole('slider', { name: 'Minimum duration' });
    const firstTitle = document.querySelector('[data-bin="0"]')?.getAttribute('title');
    await user.click(min);
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowRight}');
    expect(store.getState().condition).toBe(`${DUR} >= ${edges[2]}`);
    await waitFor(() => expect(document.querySelector('[data-bin="0"]')?.getAttribute('title')).toBeTruthy());
    expect(document.querySelector('[data-bin="0"]')?.getAttribute('title')?.split(' - ')[0]).toBe(
      firstTitle?.split(' - ')[0],
    );
  });

  test('a page opened with a duration filter pads the axis so both bounds sit on interior edges', async () => {
    setup(filtering, 10, { q: `${DUR} >= 300000 and ${DUR} <= 50000000` });
    const min = await screen.findByRole('slider', { name: 'Minimum duration' });
    const max = screen.getByRole('slider', { name: 'Maximum duration' });
    expect(min.getAttribute('aria-valuetext')).toBe('from 300 µs');
    expect(max.getAttribute('aria-valuetext')).toBe('up to 50 ms');
    expect(min.getAttribute('aria-valuenow')).toBe('1');
    expect(max.getAttribute('aria-valuenow')).toBe('22');
  });

  test('a key press on a URL-opened range widens it by one bin and keeps the other token', async () => {
    const user = userEvent.setup();
    const A = 300000;
    const B = 50000000;
    const { store } = setup(filtering, 10, { q: `${DUR} >= ${A} and ${DUR} <= ${B}` });
    const min = await screen.findByRole('slider', { name: 'Minimum duration' });
    await user.click(min);
    // The pad bin is the "unbounded" end bin, so widening onto it lifts the lower bound and keeps the upper.
    await user.keyboard('{ArrowLeft}');
    expect(store.getState().condition).toBe(`${DUR} <= ${B}`);
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(store.getState().condition).toContain(`<= ${B}`);
    expect(store.getState().condition).toContain('>=');
  });

  test('a one-sided URL filter keeps its token under a key press on the other slider', async () => {
    const user = userEvent.setup();
    const A = 300000;
    const { store } = setup(filtering, 10, { q: `${DUR} >= ${A}` });
    const min = await screen.findByRole('slider', { name: 'Minimum duration' });
    const max = screen.getByRole('slider', { name: 'Maximum duration' });
    expect(min.getAttribute('aria-valuenow')).toBe('1');
    expect(max.getAttribute('aria-valuenow')).toBe('23');
    await user.click(max);
    await user.keyboard('{ArrowRight}');
    expect(store.getState().condition).toContain(`>= ${A}`);
    await user.keyboard('{ArrowLeft}');
    expect(store.getState().condition).toContain(`>= ${A}`);
    expect(store.getState().condition).toContain('<=');
  });

  test('a committed value that is not an edge highlights its bin and ArrowLeft keeps the <= token', async () => {
    const user = userEvent.setup();
    const { store } = setup(filtering);
    const min = await screen.findByRole('slider', { name: 'Minimum duration' });
    const max = screen.getByRole('slider', { name: 'Maximum duration' });
    act(() => store.getState().setCondition(`${DUR} >= 300000 and ${DUR} <= 50000000`));
    await waitFor(() => expect(Number(min.getAttribute('aria-valuenow'))).toBeGreaterThan(0));
    expect(Number(max.getAttribute('aria-valuenow'))).toBeLessThan(23);
    await user.click(min);
    await user.keyboard('{ArrowLeft}');
    expect(store.getState().condition).toContain('<=');
  });

  test('clearing the filter re-derives the axis from the rows', async () => {
    const { store } = setup(filtering, 10, { q: `${DUR} >= 100000` });
    await screen.findByRole('slider', { name: 'Minimum duration' });
    const first = (): string | undefined =>
      document.querySelector('[data-bin="0"]')?.getAttribute('title')?.split(' - ')[0];
    expect(first()).not.toBe(formatDuration(edges[0] ?? 0));
    // The padded axis puts a bin below the 100 µs bound: the lower handle sits on edge 1, not on the first edge.
    expect(screen.getByRole('slider', { name: 'Minimum duration' }).getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByRole('slider', { name: 'Minimum duration' }).getAttribute('aria-valuetext')).toBe(
      `from ${formatDuration(100000)}`,
    );
    act(() => store.getState().clear('condition'));
    await waitFor(() => expect(first()).toBe(formatDuration(edges[0] ?? 0)));
  });
});
