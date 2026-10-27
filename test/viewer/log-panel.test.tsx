import { Tooltip } from '@base-ui/react/tooltip';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Manifest } from '../../src/format/manifest.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { RelNanos, SpanId, TraceId } from '../../src/model/ids.js';
import type { ResourceRecord, ScopeRecord } from '../../src/model/records.js';
import { formatBytes } from '../../src/semconv/formatters.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { type LogRef, type LogRow, logRef } from '../../src/viewer/data/log-query.js';
import { LogPanel } from '../../src/viewer/logs/log-panel.js';
import { GoToContext } from '../../src/viewer/shell/go-to.js';
import { MOVE_EVENT } from '../../src/viewer/shell/move-event.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { detailOf, spanIdOf, traceRow } from './trace-rows.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));
afterEach(cleanup);

const TRACE = '5134a3f57d52d9e9822e617916d38b35' as TraceId;
const ORPHAN = 'ea30c7b71377a677cb3ce2b5f8f4abb9' as TraceId;
const SPAN = '1d8745a159cef356' as SpanId;

const manifest = {
  formatVersion: 1,
  epochUnixNano: '1700000000000000000',
  totals: { spans: 1, logs: 4, metrics: 0 },
} as unknown as Manifest;

const resource: ResourceRecord = {
  attributes: new Map([
    ['service.name', { kind: 'string', value: 'checkout' }],
    ['service.version', { kind: 'string', value: '1.2.3' }],
  ]),
  droppedAttributesCount: 0,
  schemaUrl: '',
};
const scope: ScopeRecord = {
  name: 'my.scope',
  version: '9.9',
  attributes: new Map(),
  droppedAttributesCount: 0,
  schemaUrl: '',
};

function row(
  i: number,
  over: {
    body?: string;
    traceId?: TraceId | null;
    spanId?: SpanId | null;
    observed?: boolean;
    time?: number | null;
  } = {},
): LogRow {
  const time = over.time === undefined ? 1_000_000 * (i + 1) : over.time;
  return {
    ref: logRef(0, i),
    log: {
      time: time === null ? null : (time as RelNanos),
      observedTime: over.observed === false ? null : ((time ?? 5) as RelNanos),
      severityNumber: 17,
      severityText: 'ERROR',
      body: { kind: 'string', value: over.body ?? `body ${i}` },
      attributes: new Map([['decline_code', { kind: 'string', value: 'x' }]]),
      droppedAttributesCount: 0,
      flags: 0,
      traceId: over.traceId ?? null,
      spanId: over.spanId ?? null,
      eventName: '',
    },
    resource,
    scope,
    time: (time ?? 5) as RelNanos,
    timeSource: time !== null ? 'time' : over.observed === false ? 'none' : 'observed',
    service: 'checkout',
    host: 'h1',
  } as unknown as LogRow;
}

const ROWS = [
  row(0),
  row(1, { traceId: TRACE, spanId: SPAN }),
  row(2, { traceId: ORPHAN }),
  row(3, { body: '<img src=x onerror=alert(1)>' }),
];
/** A log whose span is in the mocked trace; kept out of ROWS so the list-order tests are unchanged. */
const LINKED_ROW = row(4, { traceId: TRACE, spanId: spanIdOf(2) });

function source(): DataSource {
  const byRef = (ref: LogRef): LogRow => {
    const r = [...ROWS, LINKED_ROW].find((x) => x.ref === ref);
    if (r === undefined)
      throw new OtelHtmlError('usage', {
        path: `log ${ref}`,
        expected: 'a log listed in the report',
        actual: 'not found',
      });
    return r;
  };
  return {
    manifest,
    getLog: (ref: LogRef) => Promise.resolve().then(() => byRef(ref)),
    hasTrace: (id: TraceId) => Promise.resolve(id === TRACE),
    getTrace: () =>
      Promise.resolve(
        detailOf([
          traceRow(1, null, 0, 10_000_000, { service: 'web', name: 'GET /pay', error: true }),
          traceRow(2, 1, 1_000_000, 6_000_000, { service: 'payments', name: 'Charge' }),
        ]),
      ),
    surroundingLogs: (ref: LogRef) => {
      const at = ROWS.findIndex((x) => x.ref === ref);
      return Promise.resolve({
        before: ROWS.slice(0, at),
        log: byRef(ref),
        after: ROWS.slice(at + 1),
        partial: true,
      });
    },
  } as unknown as DataSource;
}

function mount(ref: string, initial: Parameters<typeof createSelectionStore>[0] = {}) {
  const store = createSelectionStore({ log: ref as LogRef, ...initial });
  const onClose = vi.fn();
  const goTo = vi.fn();
  render(
    <ThemeProvider>
      <GoToContext.Provider value={goTo}>
        <SelectionProvider store={store}>
          <Tooltip.Provider>
            <LogPanel
              dataSource={source()}
              logRef={ref as LogRef}
              logRefs={ROWS.map((r) => r.ref)}
              onClose={onClose}
            />
          </Tooltip.Provider>
        </SelectionProvider>
      </GoToContext.Provider>
    </ThemeProvider>,
  );
  return { store, onClose, goTo };
}

describe('LogPanel', () => {
  test('a body over 16 384 characters shows the head and a Show all button sized by formatBytes', async () => {
    const user = userEvent.setup();
    const big = 'x'.repeat(1_048_576);
    ROWS[0] = row(0, { body: big });
    mount('0.0');
    const panel = await screen.findByTestId('log-panel');
    const button = await within(panel).findByRole('button', { name: `Show all (${formatBytes(1_048_576)})` });
    expect(button.textContent).toBe('Show all (1 MiB)');
    const section = within(panel).getByRole('region', { name: 'Body' });
    expect((section.textContent ?? '').length).toBeLessThan(20_000);
    await user.click(button);
    expect((within(panel).getByRole('region', { name: 'Body' }).textContent ?? '').length).toBeGreaterThan(
      1_000_000,
    );
    ROWS[0] = row(0);
  });

  test('j does nothing while a trace is also open (the trace panel owns it)', async () => {
    const { store } = mount('0.0', { trace: TRACE });
    await screen.findByTestId('log-panel');
    act(() => {
      window.dispatchEvent(new CustomEvent(MOVE_EVENT, { detail: 1 }));
    });
    expect(store.getState().logRef).toBe('0.0');
  });

  test('the header shows the severity badge and the observed time', async () => {
    mount('0.0');
    const panel = await screen.findByTestId('log-panel');
    expect(within(panel).getByText('ERROR · 17')).toBeTruthy();
    expect(within(panel).getByText(/observed/)).toBeTruthy();
  });

  test('a log without any time says so', async () => {
    const store = createSelectionStore({ log: '0.0' as LogRef });
    const ds = {
      ...source(),
      getLog: () => Promise.resolve(row(0, { time: null, observed: false })),
    } as unknown as DataSource;
    render(
      <SelectionProvider store={store}>
        <LogPanel dataSource={ds} logRef={'0.0' as LogRef} onClose={() => {}} />
      </SelectionProvider>,
    );
    expect(await screen.findByText('no timestamp')).toBeTruthy();
  });

  test('a log with only an observed time marks it observed', async () => {
    const store = createSelectionStore({ log: '0.0' as LogRef });
    const ds = {
      ...source(),
      getLog: () => Promise.resolve(row(0, { time: null })),
    } as unknown as DataSource;
    render(
      <SelectionProvider store={store}>
        <LogPanel dataSource={ds} logRef={'0.0' as LogRef} onClose={() => {}} />
      </SelectionProvider>,
    );
    expect(await screen.findByText(/^observed 2023-/)).toBeTruthy();
  });

  test('an orphan trace id is text, says it is not in the report, and hides the Trace tab', async () => {
    mount('0.2');
    const panel = await screen.findByTestId('log-panel');
    await waitFor(() => expect(within(panel).getByText('trace not in this report')).toBeTruthy());
    expect(within(panel).getByText(ORPHAN)).toBeTruthy();
    expect(within(panel).queryByRole('link', { name: ORPHAN })).toBeNull();
    expect(within(panel).queryByRole('tab', { name: 'Trace' })).toBeNull();
  });

  test('a present trace links the trace and span and shows the Trace tab', async () => {
    mount('0.1');
    const panel = await screen.findByTestId('log-panel');
    const link = await within(panel).findByRole('link', { name: TRACE });
    expect(link.getAttribute('href')).toBe(`#/traces/trace/${TRACE}`);
    expect(within(panel).getByRole('link', { name: SPAN })).toBeTruthy();
    expect(within(panel).getByRole('tab', { name: 'Trace' })).toBeTruthy();
  });

  test('a log without a trace says no trace', async () => {
    mount('0.0');
    const panel = await screen.findByTestId('log-panel');
    expect(within(panel).getByText('no trace')).toBeTruthy();
  });

  test('a span id without a trace id does not throw', async () => {
    const odd = row(0, { spanId: SPAN });
    ROWS[0] = odd;
    mount('0.0');
    const panel = await screen.findByTestId('log-panel');
    expect(within(panel).getByText('no trace')).toBeTruthy();
    expect(within(panel).getByText(`span ${SPAN}`)).toBeTruthy();
    ROWS[0] = row(0);
  });

  test('Surrounding logs lists neighbors in time order with a partial note', async () => {
    mount('0.1', { ltab: 'surrounding' });
    const panel = await screen.findByTestId('log-panel');
    const grid = await within(panel).findByRole('grid', { name: 'Results' });
    await waitFor(() => expect(within(grid).getAllByRole('row').length).toBe(5));
    const bodies = within(grid)
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.textContent ?? '');
    expect(bodies[0]).toContain('body 0');
    expect(bodies[1]).toContain('body 1');
    expect(bodies[3]).toContain('onerror');
    expect(within(panel).getByText(/partial/i)).toBeTruthy();
  });

  test('a ref that is not in the report renders the error card naming it', async () => {
    mount('99.0');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('log 99.0: expected a log listed in the report, got not found');
  });

  test('j moves to the next ref', async () => {
    const { store } = mount('0.0');
    await screen.findByTestId('log-panel');
    act(() => {
      window.dispatchEvent(new CustomEvent(MOVE_EVENT, { detail: 1 }));
    });
    expect(store.getState().logRef).toBe('0.1');
  });

  test('a hostile body renders as text and creates no img element', async () => {
    mount('0.3');
    const panel = await screen.findByTestId('log-panel');
    await waitFor(() => expect(panel.textContent).toContain('<img src=x onerror=alert(1)>'));
    expect(panel.querySelector('img')).toBeNull();
  });

  test('the Raw / Wrapped toggle switches and Close calls onClose', async () => {
    const user = userEvent.setup();
    const { onClose } = mount('0.0');
    const panel = await screen.findByTestId('log-panel');
    const raw = within(panel).getByRole('button', { name: 'Raw' });
    await user.click(raw);
    expect(raw.getAttribute('aria-pressed')).toBe('true');
    expect(within(panel).getByRole('button', { name: 'Wrapped' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(within(panel).getByRole('button', { name: 'Close log' }));
    expect(onClose).toHaveBeenCalled();
  });

  describe('Trace tab', () => {
    test('shows the trace header, the flame graph with the emitting span outlined and Open trace', async () => {
      const user = userEvent.setup();
      const { goTo } = mount('0.4', { ltab: 'trace' });
      const panel = await screen.findByTestId('log-panel');
      const tab = await within(panel).findByTestId('log-trace-tab');
      expect((await within(tab).findAllByRole('heading', { level: 3 }))[0]?.textContent).toContain('web');
      expect(within(tab).getAllByText(/2 spans/)).toBeTruthy();
      expect(within(tab).getByText('Error')).toBeTruthy();
      expect(within(tab).getByTestId('flame-graph')).toBeTruthy();
      const outline = within(tab).getByTestId('flame-outline');
      expect(outline.textContent).toContain('payments · Charge');
      expect(outline.textContent).toContain('emitted this log');
      await user.click(within(tab).getByRole('button', { name: /Open trace/ }));
      expect(goTo).toHaveBeenCalledWith('traces', `/traces/trace/${TRACE}`, { span: spanIdOf(2) });
    });

    test('clicking a span in the Waterfall opens the trace overlay and closes the log', async () => {
      const user = userEvent.setup();
      const { store } = mount('0.4', { ltab: 'trace' });
      const tab = await within(await screen.findByTestId('log-panel')).findByTestId('log-trace-tab');
      await user.click(await within(tab).findByRole('button', { name: 'Waterfall' }));
      await user.click(within(tab).getByText(/payments/));
      expect(store.getState().logRef).toBeNull();
      expect(store.getState().traceId).toBe(TRACE);
      expect(store.getState().spanId).toBe(spanIdOf(2));
    });

    test('a span_id that is not in the trace gives a muted note and no outline', async () => {
      mount('0.1', { ltab: 'trace' });
      const tab = await within(await screen.findByTestId('log-panel')).findByTestId('log-trace-tab');
      expect((await within(tab).findByRole('note')).textContent).toBe(`span ${SPAN} is not in this trace`);
      expect(within(tab).queryByTestId('flame-outline')).toBeNull();
    });
  });
});
