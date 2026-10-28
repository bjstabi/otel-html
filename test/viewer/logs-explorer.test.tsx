import { Tooltip } from '@base-ui/react/tooltip';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Manifest } from '../../src/format/manifest.js';
import { parseUnixNanos, type RelNanos, type TraceId } from '../../src/model/ids.js';
import { createNormalizeContext, normalizeLogs } from '../../src/model/normalize.js';
import { parseOtlpJson } from '../../src/model/otlp-json.js';
import { LogRollups } from '../../src/rollups/log-rollups.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { LOG_SEVERITY_KEYS, type LogSeverityKey } from '../../src/semconv/severity.js';
import { tokensToOttl } from '../../src/viewer/components/filter-tokens.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import {
  type LogQuery,
  type LogQueryResult,
  type LogRef,
  type LogRow,
  type LogTraceRow,
  type PatternRow,
  toLogEntries,
} from '../../src/viewer/data/log-query.js';
import { QUERY_FACET_CAPS } from '../../src/viewer/data/query-common.js';
import { LogsExplorer } from '../../src/viewer/logs/explorer.js';
import { MOVE_EVENT } from '../../src/viewer/shell/move-event.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { attr, logRecord, logsRequest, T0 } from '../../test-support/otlp-builders.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));
const downloads: { blob: Blob; name: string }[] = [];
vi.mock('../../src/viewer/components/export.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/viewer/components/export.js')>()),
  downloadBlob: (blob: Blob, name: string) => downloads.push({ blob, name }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  cleanup();
  downloads.length = 0;
});

const epoch = parseUnixNanos(T0, 'epoch');
const TRACE = '5134a3f57d52d9e9822e617916d38b35' as TraceId;

const manifest = (logs: number): Manifest => ({
  formatVersion: 1,
  otelHtmlVersion: '0.0.0',
  title: 'run',
  epochUnixNano: T0,
  createdAt: '2023-11-14T22:13:20.000Z',
  updatedAt: '2023-11-14T22:13:20.000Z',
  complete: true,
  range: { start: 0, end: 1_000_000_000 },
  totals: { spans: 12, logs, metrics: 7 },
  decodedBytes: 1,
  chunks: [],
  rollups: [],
  traceShards: [],
  config: { viewer: { eagerBudgetBytes: 1, listCap: 100, theme: 'system' } },
});

/** Real log rows: OTLP JSON through `normalizeLogs`, so the export can be read back the same way. */
function logRows(bodies: readonly string[]): LogRow[] {
  const req = logsRequest(
    bodies.map((b, i) =>
      logRecord({
        timeUnixNano: String(BigInt(T0) + BigInt(i * 1000)),
        severityNumber: 17,
        severityText: 'ERROR',
        body: { stringValue: b },
        attributes: [attr('decline_code', { stringValue: `c${i}` })],
        ...(i === 0 ? { traceId: TRACE } : {}),
      }),
    ),
    [attr('service.name', { stringValue: 'payments' })],
  );
  const ctx = createNormalizeContext(epoch);
  const logs = parseOtlpJson(JSON.stringify(req), 'in.json').flatMap((r) =>
    r.signal === 'logs' ? normalizeLogs(r.request, ctx, 'in.json') : [],
  );
  const chunk = { n: 0, resources: ctx.resources.entries(), scopes: ctx.scopes.entries() };
  return toLogEntries(chunk, logs, epoch, 'test').map((e) => e.row);
}

function rollupsOf(rows: readonly LogRow[]): LogRollups {
  const r = new LogRollups(QUERY_FACET_CAPS, { cluster: false });
  for (const row of rows) r.add({ log: row.log, resource: row.resource, scope: row.scope, epoch });
  return r;
}

/** The landing rollup of a 1204-log run: ERROR 122, WARN 310, INFO 702, DEBUG 70. */
function landingBuckets(): TimeBuckets<LogSeverityKey> {
  const b = new TimeBuckets<LogSeverityKey>(LOG_SEVERITY_KEYS, 8);
  const counts: Partial<Record<LogSeverityKey, number>> = { error: 122, warn: 310, info: 702, debug: 70 };
  for (const [k, n] of Object.entries(counts)) b.add(0 as RelNanos, k as LogSeverityKey, n);
  return b;
}

function logsResult(rows: LogRow[], total = rows.length): LogQueryResult {
  const r = rollupsOf(rows);
  return { mode: 'logs', rows, total, matched: total, facets: r.facets, buckets: r.buckets, partial: null };
}

const DECLINED: PatternRow = {
  id: 3,
  template: 'card declined: <*> <*>',
  regex: '^card\\s+declined:\\s+\\S+\\s+\\S+$',
  count: 6,
  severities: { unspecified: 0, trace: 0, debug: 0, info: 0, warn: 0, error: 6, fatal: 0 },
  first: 1000,
  last: 9000,
  sample: 'card declined: 402 decline_code=x',
};

function patternsResult(): LogQueryResult {
  const r = rollupsOf([]);
  return {
    mode: 'patterns',
    rows: [DECLINED],
    total: 1,
    matched: 6,
    unclustered: 0,
    facets: r.facets,
    buckets: r.buckets,
    partial: null,
  };
}

const TRACE_ROW: LogTraceRow = {
  traceId: TRACE,
  logs: 7,
  first: 1000,
  last: 5000,
  maxSeverity: 17,
  services: ['checkout', 'payments'],
};

function tracesResult(): LogQueryResult {
  const r = rollupsOf([]);
  return {
    mode: 'traces',
    rows: [TRACE_ROW],
    total: 1,
    matched: 7,
    facets: r.facets,
    buckets: r.buckets,
    partial: null,
  };
}

function scripted(q: LogQuery): LogQueryResult {
  switch (q.mode) {
    case 'logs':
      return logsResult(logRows(['card declined: 402 decline_code=a', 'retrying charge']));
    case 'patterns':
      return patternsResult();
    case 'traces':
      return tracesResult();
  }
}

function setup(
  opts: {
    logs?: number;
    initial?: Parameters<typeof createSelectionStore>[0];
    queryLogs?: (q: LogQuery) => Promise<LogQueryResult>;
    hasTrace?: (id: TraceId) => Promise<boolean>;
  } = {},
) {
  const calls: LogQuery[] = [];
  const queryLogs = opts.queryLogs ?? ((q: LogQuery) => Promise.resolve(scripted(q)));
  const ds = {
    manifest: manifest(opts.logs ?? 1204),
    strategy: 'eager',
    logStrategy: 'eager',
    queryLogs: (q: LogQuery) => {
      calls.push(q);
      return queryLogs(q);
    },
    hasTrace: opts.hasTrace ?? (() => Promise.resolve(true)),
    // The trace panel opens on a trace click; its load never settles in these tests.
    getTrace: () => new Promise(() => {}),
    // The log panel opens on log=; its load never settles in these tests.
    getLog: () => new Promise(() => {}),
  } as unknown as DataSource;
  const store = createSelectionStore(opts.initial ?? {});
  render(
    <ThemeProvider>
      <SelectionProvider store={store}>
        <Tooltip.Provider>
          <LogsExplorer dataSource={ds} />
        </Tooltip.Provider>
      </SelectionProvider>
    </ThemeProvider>,
  );
  return { store, calls };
}

describe('LogsExplorer', () => {
  test('the landing reads each number from its own source: matched, the buckets, the result total', async () => {
    const rows = logRows(['a', 'b']);
    // Every source differs on purpose: a number read from the wrong one would show up as the wrong figure.
    // The manifest total (5000) is only the zero-logs check and must not be shown.
    setup({
      logs: 5000,
      queryLogs: () =>
        Promise.resolve({ ...logsResult(rows, 1100), buckets: landingBuckets(), matched: 1300 }),
    });
    const histogram = await screen.findByRole('region', { name: '1300 logs by severity' });
    expect(histogram.textContent).toContain('1204 logs');
    const legend = within(histogram).getByRole('list', { name: 'Severity counts' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['ERROR 122', 'WARN 310', 'INFO 702', 'DEBUG 70']);
    expect(screen.getByText(/^1100 logs · showing 2$/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('5000');
  });

  test('the default query is logs mode, newest first', async () => {
    const { calls } = setup();
    await screen.findByRole('grid', { name: 'Results' });
    expect(calls[0]?.mode).toBe('logs');
    expect(calls[0]?.sort).toEqual({ column: 'time', dir: 'desc' });
  });

  test('Group into Patterns lists the template; a click filters on its regex and goes back to logs', async () => {
    const user = userEvent.setup();
    const { store, calls } = setup();
    await screen.findByRole('grid', { name: 'Results' });
    await user.click(screen.getByRole('button', { name: 'Patterns' }));
    expect(store.getState().mode).toBe('patterns');
    const cell = await screen.findByText('card declined: <*> <*>');
    const row = cell.closest('[role="row"]');
    if (!(row instanceof HTMLElement)) throw new Error('the template is in a row');
    expect(within(row).getByText('6')).toBeTruthy();
    expect(calls.at(-1)?.sort).toEqual({ column: 'count', dir: 'desc' });
    await user.click(cell);
    expect(store.getState().condition).toBe(
      tokensToOttl([{ key: 'log.body.string', op: 'matches', value: DECLINED.regex }]),
    );
    expect(store.getState().condition).toMatch(/^IsMatch\(log\.body\.string, "/);
    expect(store.getState().mode).toBeNull();
    expect(screen.getByRole('button', { name: 'Logs' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('a pattern click keeps the filter tokens already there', async () => {
    const user = userEvent.setup();
    const { store } = setup({
      initial: { mode: 'patterns', q: 'resource.attributes["service.name"] == "payments"' },
    });
    await user.click(await screen.findByText('card declined: <*> <*>'));
    expect(store.getState().condition).toBe(
      tokensToOttl([
        { key: 'resource.attributes["service.name"]', op: '==', value: 'payments' },
        { key: 'log.body.string', op: 'matches', value: DECLINED.regex },
      ]),
    );
  });

  test('clicking a pattern again with a raw OTTL query does not stack IsMatch wrappers', async () => {
    const user = userEvent.setup();
    const { store } = setup({
      initial: { mode: 'patterns', q: 'log.severity_number > 3 or log.body.string == "x"' },
    });
    await user.click(await screen.findByText('card declined: <*> <*>'));
    const once = store.getState().condition;
    expect(once).toMatch(/^\(.*\) and IsMatch\(/);
    await user.click(screen.getByRole('button', { name: 'Patterns' }));
    await user.click(await screen.findByText('card declined: <*> <*>'));
    expect(store.getState().condition).toBe(once);
  });

  test('a trace without spans filters on the condition as it is after the lookup, not before', async () => {
    const user = userEvent.setup();
    let settle: (spans: boolean) => void = () => {};
    const { store } = setup({
      initial: { mode: 'traces' },
      hasTrace: () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    });
    await user.click(await screen.findByText(TRACE));
    act(() => store.getState().setCondition('log.body.string == "edited meanwhile"'));
    await act(async () => settle(false));
    expect(store.getState().condition).toBe(
      `log.body.string == "edited meanwhile" and trace_id.string == "${TRACE}"`,
    );
  });

  test('Traces mode lists a trace row; a trace with spans opens the trace panel on its Logs tab', async () => {
    const user = userEvent.setup();
    const { store } = setup({ initial: { mode: 'traces' } });
    const grid = await screen.findByRole('grid', { name: 'Results' });
    const cell = await within(grid).findByText(TRACE);
    expect(within(grid).getByText('7')).toBeTruthy();
    await user.click(cell);
    await waitFor(() => expect(store.getState().traceId).toBe(TRACE));
    expect(store.getState().tabs.trace).toBe('logs');
  });

  test('a trace without spans filters the logs on its id instead', async () => {
    const user = userEvent.setup();
    const { store } = setup({ initial: { mode: 'traces' }, hasTrace: () => Promise.resolve(false) });
    await user.click(await screen.findByText(TRACE));
    await waitFor(() => expect(store.getState().condition).toBe(`trace_id.string == "${TRACE}"`));
    expect(store.getState().mode).toBeNull();
    expect(store.getState().traceId).toBeNull();
  });

  test('#/logs?mode=spans shows the invalid-mode notice and Reset clears it', async () => {
    const user = userEvent.setup();
    const { store, calls } = setup({ initial: { mode: 'spans' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('mode=spans is not a Logs grouping');
    expect(calls[0]?.mode).toBe('logs');
    await user.click(within(alert).getByRole('button', { name: 'Reset' }));
    expect(store.getState().mode).toBeNull();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('an invalid view says so and Reset goes back to the list', async () => {
    const user = userEvent.setup();
    const { store } = setup({ initial: { view: 'pointplot' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('view=pointplot is not a Logs view');
    await user.click(within(alert).getByRole('button', { name: 'Reset' }));
    expect(store.getState().view).toBe('list');
  });

  test('Scatter outside logs mode says it plots individual logs instead of drawing an empty chart', async () => {
    setup({ initial: { mode: 'patterns', view: 'scatter' } });
    expect(
      await screen.findByText('Scatter plots individual logs; switch Group into back to Logs.'),
    ).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Scatter/ })).toBeNull();
  });

  test('Scatter in logs mode draws the chart and shows no note', async () => {
    setup({ initial: { view: 'scatter' } });
    await screen.findByRole('region', { name: /logs by severity/ });
    expect(screen.queryByText(/Scatter plots individual logs/)).toBeNull();
  });

  test('the View select offers exactly the Logs views', async () => {
    setup();
    const select = (await screen.findByLabelText('View')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      'list',
      'timeseries',
      'toplist',
      'bar',
      'table',
      'treemap',
      'pie',
      'scatter',
    ]);
  });

  test('Export OTLP JSON round-trips through normalizeLogs with equal bodies', async () => {
    const user = userEvent.setup();
    const rows = logRows(['card declined: 402 decline_code=a', '</script> retrying', 'third']);
    setup({ queryLogs: () => Promise.resolve(logsResult(rows, 5)) });
    await screen.findByRole('grid', { name: 'Results' });
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export OTLP JSON' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    const [file] = downloads;
    if (file === undefined) throw new Error('one download');
    expect(file.name).toBe('logs-first-3-of-5.otlp.json');
    const ctx = createNormalizeContext(epoch);
    const back = parseOtlpJson(await file.blob.text(), 'out.json').flatMap((r) =>
      r.signal === 'logs' ? normalizeLogs(r.request, ctx, 'out.json') : [],
    );
    expect(back.map((l) => l.body)).toEqual(rows.map((r) => r.log.body));
    expect(back.map((l) => l.traceId)).toEqual(rows.map((r) => r.log.traceId));
  });

  test('Export CSV is named after the logs it holds', async () => {
    const user = userEvent.setup();
    setup({ queryLogs: () => Promise.resolve(logsResult(logRows(['a', 'b']))) });
    await screen.findByRole('grid', { name: 'Results' });
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export CSV' }));
    await waitFor(() => expect(downloads.map((d) => d.name)).toEqual(['logs-2.csv']));
  });

  test('a row click selects the log and marks the row', async () => {
    const user = userEvent.setup();
    const { store } = setup();
    const grid = await screen.findByRole('grid', { name: 'Results' });
    await user.click(within(grid).getByText('retrying charge'));
    expect(store.getState().logRef).toBe('0.1');
    await waitFor(() =>
      expect(within(grid).getByText('retrying charge').closest('[aria-selected="true"]')).not.toBeNull(),
    );
  });

  test('with log= open and the query still pending, j is a no-op; once the rows arrive j moves', async () => {
    let resolve: (r: LogQueryResult) => void = () => {};
    const pending = new Promise<LogQueryResult>((r) => {
      resolve = r;
    });
    const { store } = setup({ queryLogs: () => pending, initial: { log: '0.0' as LogRef } });
    await screen.findByTestId('log-panel');
    const press = (): void =>
      act(() => {
        window.dispatchEvent(new CustomEvent(MOVE_EVENT, { detail: 1 }));
      });
    press();
    expect(store.getState().logRef).toBe('0.0');
    await act(async () => {
      resolve(scripted({ mode: 'logs' } as LogQuery));
      await pending;
    });
    await screen.findByRole('grid', { name: 'Results' });
    press();
    expect(store.getState().logRef).toBe('0.1');
  });

  test('no match shows "No logs match" and Clear filters clears the condition and text', async () => {
    const user = userEvent.setup();
    const { store } = setup({ queryLogs: () => Promise.resolve(logsResult([])), initial: { text: 'zzz' } });
    const empty = (await screen.findByText('No logs match')).closest('section');
    if (empty === null) throw new Error('the empty state is a section');
    await user.click(within(empty).getByRole('button', { name: 'Clear filters' }));
    expect(store.getState().text).toBe('');
  });

  test('a zero-log report says so and counts the other signals', () => {
    const queryLogs = vi.fn();
    setup({ logs: 0, queryLogs });
    const card = screen.getByText('This report has no logs').closest('section');
    if (card === null) throw new Error('the zero state is a section');
    expect(card.textContent).toContain('12 spans and 7 metric data points');
    expect(queryLogs).not.toHaveBeenCalled();
  });

  test('a zero-log report still shows the invalid mode notice', () => {
    setup({ logs: 0, initial: { mode: 'spans', view: 'pointplot' } });
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts.some((t) => t?.includes('mode=spans is not a Logs grouping'))).toBe(true);
    expect(alerts.some((t) => t?.includes('view=pointplot is not a Logs view'))).toBe(true);
  });

  test('a failing query renders a designed error with its message', async () => {
    setup({ queryLogs: () => Promise.reject(new Error('data/chunks/logs/000002.js: failed to load')) });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The query could not run')).toBeTruthy();
    expect(alert.textContent).toContain('000002.js: failed to load');
  });
});
