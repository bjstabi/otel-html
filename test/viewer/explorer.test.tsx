import { Tooltip } from '@base-ui/react/tooltip';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Manifest } from '../../src/format/manifest.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { RedSeries } from '../../src/rollups/red.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { formatDuration } from '../../src/semconv/formatters.js';
import type { DataSource, SpanQuery, SpanQueryResult, SpanRow } from '../../src/viewer/data/data-source.js';
import { type GoTo, GoToContext } from '../../src/viewer/shell/go-to.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { TracesExplorer } from '../../src/viewer/traces/explorer.js';
import { durationAxis } from '../../src/viewer/traces/views.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const HOSTILE = '</script><img src=x onerror=alert(1)> ';

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
  metricFiles: [],
  config: {
    viewer: {
      eagerBudgetBytes: 1,
      listCap: 100,
      theme: 'system',
      defaultDashboard: 'fusion',
      home: 'traces',
    },
    dashboards: [],
    views: [],
  },
});

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

function resultOf(rows: SpanRow[], partial: SpanQueryResult['partial'] = null): SpanQueryResult {
  const facets = new FacetCounts(100, 50, ['service.name', 'status.code']);
  for (const r of rows) facets.add('service.name', r.service);
  return {
    rows,
    total: rows.length,
    facets,
    buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
    red: new RedSeries(8),
    groups: null,
    partial,
  };
}

function setup(
  querySpans: DataSource['querySpans'],
  spans = 10,
  initial: Parameters<typeof createSelectionStore>[0] = {},
) {
  const ds = { manifest: manifest(spans), strategy: 'eager', querySpans } as DataSource;
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

  test('partial results read "from N of M chunks" and Scan entire run re-queries with scanAll', async () => {
    const user = userEvent.setup();
    const calls: SpanQuery[] = [];
    setup((q) => {
      calls.push(q);
      return Promise.resolve(resultOf([row('a', 's', 5, 's1')], q.scanAll ? null : { scanned: 3, total: 9 }));
    });
    const note = await screen.findByRole('status', { name: 'Partial results' });
    expect(note.textContent).toBe('from 3 of 9 chunks · Scan entire run');
    await user.click(screen.getByRole('button', { name: 'Scan entire run' }));
    await waitFor(() => expect(calls.at(-1)?.scanAll).toBe(true));
    await waitFor(() => expect(screen.queryByText(/from 3 of 9 chunks/)).toBeNull());
  });

  test('a failing query renders a designed error with its message', async () => {
    setup(() => Promise.reject(new Error('data/chunks/spans/000003.js: failed to load')));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The query could not run')).toBeTruthy();
    expect(alert.textContent).toContain('data/chunks/spans/000003.js: failed to load');
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

  test('the duration distribution is labelled with N and M when the rows are the first N of M', async () => {
    const rows = [row('a', 's', 5, 's1'), row('b', 's', 50, 's2')];
    setup(() => Promise.resolve({ ...resultOf(rows), total: 40 }));
    const note = await screen.findByTestId('duration-bins-note');
    expect(note.textContent).toBe('Duration distribution is from the first 2 of 40 spans');
  });

  test('a complete result carries no duration caveat', async () => {
    setup(() => Promise.resolve(resultOf([row('a', 's', 5, 's1')])));
    await screen.findByRole('grid', { name: 'Results' });
    expect(screen.queryByTestId('duration-bins-note')).toBeNull();
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
  const filtering: DataSource['querySpans'] = (q) => {
    const lo = />= (\d+(?:\.\d+)?)/.exec(q.condition ?? '')?.[1];
    const hi = /<= (\d+(?:\.\d+)?)/.exec(q.condition ?? '')?.[1];
    return Promise.resolve(
      resultOf(
        ROWS.filter(
          (r) =>
            (lo === undefined || r.durationNs >= Number(lo)) &&
            (hi === undefined || r.durationNs <= Number(hi)),
        ),
      ),
    );
  };
  const edges = durationAxis(ROWS, 24);

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
    expect(first()).not.toBe(formatDuration(100000));
    act(() => store.getState().clear('condition'));
    await waitFor(() => expect(first()).toBe(formatDuration(edges[0] ?? 0)));
  });
});
