import { Tooltip } from '@base-ui/react/tooltip';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Manifest } from '../../src/format/manifest.js';
import type { RelNanos, TraceId } from '../../src/model/ids.js';
import { compileCondition } from '../../src/ottl/compile.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { RedSeries } from '../../src/rollups/red.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import type {
  DataSource,
  SpanQueryResult,
  TraceDetail,
  TraceRow,
} from '../../src/viewer/data/data-source.js';
import { type LogRow, logRef } from '../../src/viewer/data/log-query.js';
import { type GoTo, GoToContext } from '../../src/viewer/shell/go-to.js';
import { MOVE_EVENT } from '../../src/viewer/shell/move-event.js';
import { applyPatch, carryTo } from '../../src/viewer/state/carry.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { serializeUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { TracesExplorer } from '../../src/viewer/traces/explorer.js';
import { SPLIT_STORAGE_KEY } from '../../src/viewer/traces/split-pane.js';
import { TracePanel, type TracePanelProps } from '../../src/viewer/traces/trace-panel.js';
import { detailOf, spanIdOf, str, TRACE_ID, traceRow } from './trace-rows.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const HOSTILE = '</script><img src=x onerror=alert(1)> ';
const manifest: Manifest = {
  formatVersion: 1,
  otelHtmlVersion: '0.0.0',
  title: 'run',
  epochUnixNano: '1700000000000000000',
  createdAt: '2023-11-14T22:13:20.000Z',
  updatedAt: '2023-11-14T22:13:20.000Z',
  complete: true,
  range: { start: 0, end: 1_000_000_000 },
  totals: { spans: 6, logs: 0, metrics: 0 },
  decodedBytes: 1,
  chunks: [],
  rollups: [],
  traceShards: [],
  config: { viewer: { eagerBudgetBytes: 1, listCap: 100, theme: 'system' } },
};

const okDetail = (): TraceDetail =>
  detailOf([
    traceRow(1, null, 1_000_000, 51_000_000, {
      service: 'web',
      name: 'GET /cart',
      attributes: new Map([
        ['http.request.method', str('GET')],
        ['url.path', str('/cart?id=7')],
        ['http.response.status_code', str('200')],
      ]),
    }),
    traceRow(2, 1, 2_000_000, 12_000_000, { service: 'db', name: 'db.query' }),
  ]);
const errDetail = (): TraceDetail =>
  detailOf([
    traceRow(1, null, 0, 100, { service: 'web', name: 'GET /' }),
    traceRow(2, 1, 10, 50, { service: 'db', name: 'db.query', error: true }),
  ]);

function source(over: Partial<DataSource> = {}): DataSource {
  return {
    manifest,
    strategy: 'eager',
    getTrace: () => Promise.resolve(okDetail()),
    percentileOf: () => 97.2,
    ...over,
  } as DataSource;
}

function mount(
  props: Partial<TracePanelProps> = {},
  initial: Parameters<typeof createSelectionStore>[0] = {},
) {
  const store = createSelectionStore(initial);
  const onClose = vi.fn();
  render(
    <ThemeProvider>
      <SelectionProvider store={store}>
        <Tooltip.Provider>
          <TracePanel
            dataSource={source()}
            traceId={TRACE_ID}
            layout="overlay"
            onClose={onClose}
            {...props}
          />
        </Tooltip.Provider>
      </SelectionProvider>
    </ThemeProvider>,
  );
  return { store, onClose };
}

describe('TracePanel header', () => {
  test('shows root service > resource > trace id, percentile badge, duration, request, code, counts and start', async () => {
    mount();
    const header = await screen.findByTestId('trace-header');
    expect(header.querySelector('h2')?.textContent).toContain('web');
    expect(header.querySelector('h2')?.textContent).toContain('/r');
    expect(header.querySelector('h2')?.textContent).toContain(TRACE_ID);
    expect(within(header).getByText('p97')).toBeTruthy();
    expect(within(header).getByText('50.0 ms'.replace('.0', ''))).toBeTruthy();
    expect(within(header).getByText('GET /cart?id=7')).toBeTruthy();
    expect(within(header).getByText('200')).toBeTruthy();
    expect(within(header).getByText('No errors')).toBeTruthy();
    expect(within(header).getByText('2023-11-14T22:13:20.001Z')).toBeTruthy();
    const counts = ['Spans', 'Services', 'Errors'].map(
      (l) => within(header).getByText(l).nextElementSibling?.textContent,
    );
    expect(counts).toEqual(['2', '2', '0']);
  });

  test('an unknown percentile shows no badge, never a fake value', async () => {
    mount({ dataSource: source({ percentileOf: () => null }) });
    const header = await screen.findByTestId('trace-header');
    expect(within(header).queryByText(/^p\d+$/)).toBeNull();
  });

  test('error state is an icon plus a count label', async () => {
    mount({ dataSource: source({ getTrace: () => Promise.resolve(errDetail()) }) });
    const header = await screen.findByTestId('trace-header');
    expect(within(header).getByText('1 error')).toBeTruthy();
  });

  test('hostile service, resource, name, URL and trace text render as text only', async () => {
    const hostile = detailOf([
      traceRow(1, null, 0, 100, {
        service: HOSTILE,
        name: HOSTILE,
        attributes: new Map([['url.full', str(HOSTILE)]]),
      }),
    ]);
    const { store } = mount(
      { dataSource: source({ getTrace: () => Promise.resolve(hostile) }) },
      { tab: 'waterfall' },
    );
    const header = await screen.findByTestId('trace-header');
    expect(header.textContent).toContain(HOSTILE);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(store.getState().tabs.trace).toBe('waterfall');
    expect(screen.getByRole('tree', { name: 'Waterfall' }).textContent).toContain(HOSTILE);
  });

  test('shows a designed skeleton while loading and an error naming the trace on failure', async () => {
    let reject: (e: Error) => void = () => undefined;
    mount({
      dataSource: source({
        getTrace: () =>
          new Promise<TraceDetail>((_, r) => {
            reject = r;
          }),
      }),
    });
    expect(screen.getByRole('status', { name: 'Loading trace' })).toBeTruthy();
    await act(async () => undefined); // let the (deferred) getTrace call start
    await act(async () => reject(new Error('data/traces/shard-0003.js: failed to load')));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(`trace ${TRACE_ID}`);
    expect(alert.textContent).toContain('data/traces/shard-0003.js: failed to load');
  });

  test('a getTrace that throws synchronously lands in the same error card', async () => {
    mount({
      dataSource: source({
        getTrace: () => {
          throw new Error('boom');
        },
      }),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
  });
});

describe('TracePanel tabs', () => {
  test('defaults to the flame graph; the Errors tab is hidden for an error-free trace', async () => {
    mount();
    expect(await screen.findByTestId('flame-graph')).toBeTruthy();
    const names = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(names).toEqual(['Flame graph', 'Waterfall', 'Span list', 'Services']);
  });

  test('the Errors tab shows when a span errored and lists it', async () => {
    const user = userEvent.setup();
    const { store } = mount({ dataSource: source({ getTrace: () => Promise.resolve(errDetail()) }) });
    await user.click(await screen.findByRole('tab', { name: 'Errors' }));
    expect(store.getState().tabs.trace).toBe('errors');
    const table = screen.getByRole('table', { name: 'Errors in this trace' });
    expect(within(table).getByRole('button', { name: 'db.query' })).toBeTruthy();
    await user.click(within(table).getByRole('button', { name: 'db.query' }));
    expect(store.getState().spanId).toBe(errDetail().spans[1]?.span.spanId);
  });

  test('a stored tab that is not available falls back to the first tab', async () => {
    mount({}, { tab: 'errors' });
    expect(await screen.findByTestId('flame-graph')).toBeTruthy();
  });

  test('Services lists every service with its span count', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('tab', { name: 'Services' }));
    const table = screen.getByRole('table', { name: 'Services in this trace' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(table.textContent).toContain('web');
    expect(table.textContent).toContain('db');
  });

  test('Span list selects a span by row click', async () => {
    const user = userEvent.setup();
    const { store } = mount();
    await user.click(await screen.findByRole('tab', { name: 'Span list' }));
    await user.click(within(screen.getByRole('grid', { name: 'Results' })).getByText('db'));
    expect(store.getState().spanId).toBe(okDetail().spans[1]?.span.spanId);
  });
});

describe('TracePanel actions and layout', () => {
  test('overlay has Full page (a link to the route), page layout does not; Close calls onClose', async () => {
    const user = userEvent.setup();
    const { onClose } = mount();
    await screen.findByTestId('trace-header');
    expect(screen.getByRole('link', { name: 'Full page' }).getAttribute('href')).toBe(
      `#/traces/trace/${TRACE_ID}`,
    );
    await user.click(screen.getByRole('button', { name: 'Close trace' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    mount({ layout: 'page' });
    await screen.findByTestId('trace-header');
    expect(screen.queryByRole('link', { name: 'Full page' })).toBeNull();
    expect(screen.getByTestId('trace-panel').getAttribute('role')).not.toBe('dialog');
  });

  test('Export trace downloads the trace as OTLP JSON built by the report exporter', async () => {
    const user = userEvent.setup();
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', {
      createObjectURL: (b: Blob) => {
        blobs.push(b);
        return 'blob:x';
      },
      revokeObjectURL: () => undefined,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mount();
    await screen.findByTestId('trace-header');
    await user.click(screen.getByRole('button', { name: 'Export trace' }));
    expect(click).toHaveBeenCalledTimes(1);
    const text = await new Promise<string>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.readAsText(blobs[0] ?? new Blob());
    });
    const json: unknown = JSON.parse(text);
    expect(json).toMatchObject({ resourceSpans: expect.any(Array) });
    expect(text).toContain('GET /cart');
    vi.unstubAllGlobals();
  });

  test('the span section is mounted by default and replaceable through a prop', async () => {
    mount();
    expect(await screen.findByRole('region', { name: 'Span details' })).toBeTruthy();
    cleanup();
    mount({ renderSpanSection: (p) => <p data-testid="task22">{p.detail.spans.length} spans</p> });
    expect((await screen.findByTestId('task22')).textContent).toBe('2 spans');
    expect(screen.queryByRole('region', { name: 'Span details' })).toBeNull();
  });
});

describe('split', () => {
  test('keyboard resizes within 20..80 and the position is remembered', async () => {
    const user = userEvent.setup();
    mount();
    const sep = await screen.findByRole('separator', { name: /Resize/ });
    expect(sep.getAttribute('aria-valuenow')).toBe('55');
    sep.focus();
    await user.keyboard('{ArrowUp}');
    expect(sep.getAttribute('aria-valuenow')).toBe('50');
    await user.keyboard('{Home}');
    expect(sep.getAttribute('aria-valuenow')).toBe('20');
    await user.keyboard('{ArrowUp}');
    expect(sep.getAttribute('aria-valuenow')).toBe('20');
    await user.keyboard('{End}{ArrowDown}');
    expect(sep.getAttribute('aria-valuenow')).toBe('80');
    expect(window.localStorage.getItem(SPLIT_STORAGE_KEY)).toBe('80');
    cleanup();
    mount();
    expect((await screen.findByRole('separator', { name: /Resize/ })).getAttribute('aria-valuenow')).toBe(
      '80',
    );
  });

  test('works without localStorage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const user = userEvent.setup();
    mount();
    const sep = await screen.findByRole('separator', { name: /Resize/ });
    sep.focus();
    await user.keyboard('{ArrowDown}');
    expect(sep.getAttribute('aria-valuenow')).toBe('60');
  });

  test('a stored value outside the range is clamped', async () => {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, '5');
    mount();
    expect((await screen.findByRole('separator', { name: /Resize/ })).getAttribute('aria-valuenow')).toBe(
      '20',
    );
  });
});

describe('j/k ownership', () => {
  const ids = ['a', 'b', 'c'].map((c) => c.repeat(32) as TraceId);
  const traceRowOf = (id: TraceId, i: number): TraceRow => ({
    traceId: id,
    root: null,
    rootSummary: { service: `svc-${i}`, name: `root-${i}`, resource: `res-${i}` },
    start: i * 1000,
    durationNs: 500,
    spans: 2,
    errors: 0,
    shareComplete: false,
    serviceShare: [],
  });

  function setup() {
    const result: SpanQueryResult = {
      rows: ids.map(traceRowOf),
      total: 3,
      facets: new FacetCounts(100, 50, ['service.name']),
      buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
      red: new RedSeries(8),
      partial: null,
    };
    const ds = source({
      querySpans: () => Promise.resolve(result),
      getTrace: (id: TraceId) => Promise.resolve({ ...okDetail(), traceId: id }),
    });
    const store = createSelectionStore({ mode: 'traces' });
    render(
      <ThemeProvider>
        <SelectionProvider store={store}>
          <Tooltip.Provider>
            <TracesExplorer dataSource={ds} />
          </Tooltip.Provider>
        </SelectionProvider>
      </ThemeProvider>,
    );
    return store;
  }
  const press = (delta: 1 | -1): void => {
    act(() => {
      window.dispatchEvent(new CustomEvent(MOVE_EVENT, { detail: delta }));
    });
  };

  test('with the panel closed the table moves; with it open the panel owns the key and exactly one consumer acts', async () => {
    const store = setup();
    await screen.findAllByRole('row');
    press(1);
    expect(store.getState().traceId).toBe(ids[0]);
    await screen.findByTestId('trace-panel');
    let writes = 0;
    store.subscribe(() => writes++);
    press(1);
    expect(store.getState().traceId).toBe(ids[1]);
    expect(writes).toBe(1); // one consumer per press: the table stands down while the panel is open
    press(1);
    expect(store.getState().traceId).toBe(ids[2]);
    press(1); // clamps at the end
    expect(store.getState().traceId).toBe(ids[2]);
    press(-1);
    expect(store.getState().traceId).toBe(ids[1]);
    await waitFor(() => expect(screen.getByTestId('trace-header')).toBeTruthy());
  });

  test('two presses before a re-render move two traces (the open trace is read at event time)', async () => {
    const store = setup();
    await screen.findAllByRole('row');
    press(1);
    await screen.findByTestId('trace-panel');
    act(() => {
      window.dispatchEvent(new CustomEvent(MOVE_EVENT, { detail: 1 }));
      window.dispatchEvent(new CustomEvent(MOVE_EVENT, { detail: 1 }));
    });
    expect(store.getState().traceId).toBe(ids[2]);
    await waitFor(() => expect(screen.getByTestId('trace-header')).toBeTruthy());
  });

  test('clicking a row opens the panel with the root resource; closing restores focus to the row', async () => {
    const user = userEvent.setup();
    const store = setup();
    const row = (await screen.findByText('res-1')).closest('[role="row"]');
    if (!(row instanceof HTMLElement)) throw new Error('row');
    await user.click(row);
    expect(store.getState().traceId).toBe(ids[1]);
    const panel = await screen.findByTestId('trace-panel');
    expect(await within(panel).findByTestId('trace-header')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Close trace' }));
    await waitFor(() => expect(screen.queryByTestId('trace-panel')).toBeNull());
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('row'));
  });
});

describe('TracePanel Logs tabs', () => {
  const logRow = (i: number, ns: number, spanId: string | null, body: string, traceId = TRACE_ID): LogRow =>
    ({
      ref: logRef(0, i),
      log: {
        time: ns as RelNanos,
        observedTime: null,
        severityNumber: 9,
        severityText: 'INFO',
        body: { kind: 'string', value: body },
        attributes: new Map(),
        droppedAttributesCount: 0,
        flags: 0,
        traceId,
        spanId,
        eventName: '',
      },
      resource: {},
      scope: {},
      time: ns as RelNanos,
      timeSource: 'time',
      service: 'web',
      host: 'h1',
    }) as unknown as LogRow;
  // Time-ascending as `traceLogs` returns them: two on span 2, one on span 1 and one on a span not in the trace.
  const LOGS = [
    logRow(0, 10, spanIdOf(2).toString(), 'first'),
    logRow(1, 20, spanIdOf(1).toString(), 'second'),
    logRow(2, 30, spanIdOf(2).toString(), 'third'),
    logRow(3, 40, 'deadbeefdeadbeef', 'dangling'),
  ];
  const withLogs = (logs: readonly LogRow[]): DataSource =>
    source({
      getTrace: () => Promise.resolve({ ...okDetail(), logCount: logs.length }),
      traceLogs: () => Promise.resolve(logs),
    });

  function mountLogs(
    initial: Parameters<typeof createSelectionStore>[0] = {},
    renderSpan = false,
    logs: readonly LogRow[] = LOGS,
    traceIds?: readonly TraceId[],
  ) {
    const store = createSelectionStore(initial);
    const jumps: string[] = [];
    const goTo: GoTo = (page, route, extra = {}) => {
      const { url } = carryTo(store.getState(), 'traces', page);
      jumps.push(`#${route}?${serializeUrlState(applyPatch(url, extra))}`);
    };
    render(
      <ThemeProvider>
        <GoToContext.Provider value={goTo}>
          <SelectionProvider store={store}>
            <Tooltip.Provider>
              <TracePanel
                dataSource={withLogs(logs)}
                traceId={TRACE_ID}
                layout="overlay"
                onClose={() => undefined}
                {...(traceIds === undefined ? {} : { traceIds })}
                {...(renderSpan ? {} : { renderSpanSection: () => null })}
              />
            </Tooltip.Provider>
          </SelectionProvider>
        </GoToContext.Provider>
      </ThemeProvider>,
    );
    return { store, jumps };
  }
  const decodedQuery = (hash: string | undefined): string | null =>
    new URLSearchParams((hash ?? '').split('?')[1] ?? '').get('q');

  test('logs load once for both tabs, and a trace change aborts and drops the stale load', async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    const traceLogs = vi.fn((_id: TraceId, signal?: AbortSignal) => {
      if (signal !== undefined) signals.push(signal);
      return Promise.resolve(LOGS);
    });
    const ds = source({
      getTrace: () => Promise.resolve({ ...okDetail(), logCount: LOGS.length }),
      traceLogs,
    });
    const store = createSelectionStore({ span: spanIdOf(2) });
    const view = (traceId: TraceId) => (
      <ThemeProvider>
        <GoToContext.Provider value={() => undefined}>
          <SelectionProvider store={store}>
            <Tooltip.Provider>
              <TracePanel dataSource={ds} traceId={traceId} layout="overlay" onClose={() => undefined} />
            </Tooltip.Provider>
          </SelectionProvider>
        </GoToContext.Provider>
      </ThemeProvider>
    );
    const { rerender } = render(view(TRACE_ID));
    await user.click(await screen.findByRole('tab', { name: 'Logs' }));
    await screen.findByTestId('trace-logs-tab');
    await user.click(
      await within(screen.getByRole('tablist', { name: 'Span views' })).findByRole('tab', { name: 'Logs' }),
    );
    await screen.findByTestId('span-logs-tab');
    expect(traceLogs).toHaveBeenCalledTimes(1);
    const other = 'b'.repeat(32) as TraceId;
    rerender(view(other));
    expect(signals[0]?.aborted).toBe(true);
    await waitFor(() => expect(traceLogs).toHaveBeenCalledTimes(2));
    expect(traceLogs.mock.calls[1]?.[0]).toBe(other);
  });

  test('a failed logs load shows an alert in the trace Logs tab and in the span Logs tab', async () => {
    const user = userEvent.setup();
    const ds = source({
      getTrace: () => Promise.resolve({ ...okDetail(), logCount: 2 }),
      traceLogs: () => Promise.reject(new Error('shard 4 is corrupt')),
    });
    const store = createSelectionStore({ span: spanIdOf(2) });
    render(
      <ThemeProvider>
        <GoToContext.Provider value={() => undefined}>
          <SelectionProvider store={store}>
            <Tooltip.Provider>
              <TracePanel dataSource={ds} traceId={TRACE_ID} layout="overlay" onClose={() => undefined} />
            </Tooltip.Provider>
          </SelectionProvider>
        </GoToContext.Provider>
      </ThemeProvider>,
    );
    await user.click(await screen.findByRole('tab', { name: 'Logs' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The logs could not be loaded: shard 4 is corrupt');
    await user.click(
      await within(screen.getByRole('tablist', { name: 'Span views' })).findByRole('tab', { name: 'Logs' }),
    );
    expect((await screen.findByTestId('span-logs-error')).textContent).toContain('shard 4 is corrupt');
  });

  test('a move event with focus inside the embedded list is left to the trace panel', async () => {
    const user = userEvent.setup();
    const ids = [TRACE_ID, 'b'.repeat(32) as TraceId];
    const { store } = mountLogs({ trace: TRACE_ID }, false, LOGS, ids);
    await user.click(await screen.findByRole('tab', { name: 'Logs' }));
    const tab = await screen.findByTestId('trace-logs-tab');
    within(tab).getAllByRole('row')[1]?.focus();
    act(() => {
      window.dispatchEvent(new CustomEvent(MOVE_EVENT, { detail: 1 }));
    });
    expect(store.getState().traceId).toBe(ids[1]);
  });

  test('the trace Logs tab lists the trace logs in time order and the compiled query is valid', async () => {
    const user = userEvent.setup();
    mountLogs();
    await user.click(await screen.findByRole('tab', { name: 'Logs' }));
    const tab = await screen.findByTestId('trace-logs-tab');
    const bodies = within(tab)
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.textContent ?? '');
    expect(
      bodies.map((b) => ['first', 'second', 'third', 'dangling'].findIndex((w) => b.includes(w))),
    ).toEqual([0, 1, 2, 3]);
    expect(within(tab).getByText('4 logs')).toBeTruthy();
    expect(() =>
      compileCondition(
        `trace_id.string == "${TRACE_ID}" and span_id.string == "${spanIdOf(2)}"`,
        'log_record',
      ),
    ).not.toThrow();
  });

  test('Open in Logs Explorer writes the trace query and carries the window', async () => {
    const user = userEvent.setup();
    const { jumps } = mountLogs({ t: '0~1000' });
    await user.click(await screen.findByRole('tab', { name: 'Logs' }));
    await user.click(await screen.findByRole('button', { name: 'Open in Logs Explorer' }));
    expect(jumps[0]?.startsWith('#/logs?')).toBe(true);
    expect(decodedQuery(jumps[0])).toBe(`trace_id.string == "${TRACE_ID}"`);
    expect(new URLSearchParams(jumps[0]?.split('?')[1]).get('t')).toBe('0~1000');
  });

  test('a row click opens that log in the Logs Explorer with its Attributes tab', async () => {
    const user = userEvent.setup();
    const { jumps } = mountLogs();
    await user.click(await screen.findByRole('tab', { name: 'Logs' }));
    await user.click(await screen.findByText('second'));
    const params = new URLSearchParams(jumps[0]?.split('?')[1]);
    expect(params.get('log')).toBe('0.1');
    expect(params.get('ltab')).toBe('attributes');
    expect(params.get('q')).toBe(`trace_id.string == "${TRACE_ID}"`);
  });

  test('the embedded list sorts locally', async () => {
    const user = userEvent.setup();
    mountLogs();
    await user.click(await screen.findByRole('tab', { name: 'Logs' }));
    const tab = await screen.findByTestId('trace-logs-tab');
    await user.click(within(within(tab).getByRole('columnheader', { name: /Time/ })).getByRole('button'));
    const first = within(tab).getAllByRole('row')[1];
    expect(first?.textContent).toContain('dangling');
  });

  test('the span Logs tab lists only the span logs; a dangling span id never shows another span or trace', async () => {
    const user = userEvent.setup();
    const { jumps } = mountLogs({ span: spanIdOf(2) }, true);
    const spanTabs = await screen.findByRole('tablist', { name: 'Span views' });
    await user.click(await within(spanTabs).findByRole('tab', { name: 'Logs' }));
    const list = await screen.findByTestId('span-logs-tab');
    const text = list.textContent ?? '';
    expect(text).toContain('first');
    expect(text).toContain('third');
    expect(text).not.toContain('second');
    expect(text).not.toContain('dangling');
    await user.click(within(list).getByRole('button', { name: 'Open in Logs Explorer' }));
    expect(decodedQuery(jumps[0])).toBe(
      `trace_id.string == "${TRACE_ID}" and span_id.string == "${spanIdOf(2)}"`,
    );
  });

  test('a span with no logs has no Logs tab', async () => {
    mountLogs({ span: spanIdOf(1) }, true, [LOGS[0] as LogRow]);
    await screen.findByRole('tablist', { name: 'Span views' });
    expect(
      within(screen.getByRole('tablist', { name: 'Span views' })).queryByRole('tab', { name: 'Logs' }),
    ).toBeNull();
  });
});
