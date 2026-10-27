import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseUnixNanos, type RelNanos, type SpanId, type TraceId } from '../../src/model/ids.js';
import type { ResourceRecord, ScopeRecord } from '../../src/model/records.js';
import { type LogRow, logRef } from '../../src/viewer/data/log-query.js';
import { GoToContext } from '../../src/viewer/shell/go-to.js';
import { TraceLogsTab } from '../../src/viewer/traces/trace-logs-tab.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const epoch = parseUnixNanos('1700000000000000000', 'epoch');
const TRACE_A = '5134a3f57d52d9e9822e617916d38b35' as TraceId;
const TRACE_B = 'ea30c7b71377a677cb3ce2b5f8f4abb9' as TraceId;
const SPAN_1 = '1d8745a159cef356' as SpanId;
const SPAN_2 = '2d8745a159cef356' as SpanId;

function row(i: number): LogRow {
  return {
    ref: logRef(0, i),
    log: {
      time: (1_000_000 * (i + 1)) as RelNanos,
      observedTime: null,
      severityNumber: 9,
      severityText: 'INFO',
      body: { kind: 'string', value: `body ${i}` },
      attributes: new Map(),
      droppedAttributesCount: 0,
      flags: 0,
      traceId: TRACE_A,
      spanId: SPAN_1,
      eventName: '',
    },
    resource: {} as ResourceRecord,
    scope: {} as ScopeRecord,
    time: (1_000_000 * (i + 1)) as RelNanos,
    timeSource: 'time',
    service: 'web',
    host: 'h1',
  } as unknown as LogRow;
}

const ROWS = [row(0), row(1)];
const timeSort = (): string | null =>
  screen.getByRole('columnheader', { name: /Time/ }).getAttribute('aria-sort');

function tab(scope: Parameters<typeof TraceLogsTab>[0]['scope']): JSX.Element {
  return (
    <GoToContext.Provider value={vi.fn()}>
      <TraceLogsTab rows={ROWS} scope={scope} epoch={epoch} />
    </GoToContext.Provider>
  );
}

describe('TraceLogsTab', () => {
  test.each([
    ['another span', { traceId: TRACE_A, spanId: SPAN_2 }],
    ['another trace', { traceId: TRACE_B, spanId: SPAN_1 }],
  ])('a sort chosen for one span goes back to time ascending on %s', async (_name, next) => {
    const user = userEvent.setup();
    const { rerender } = render(tab({ traceId: TRACE_A, spanId: SPAN_1 }));
    expect(timeSort()).toBe('ascending');
    await user.click(screen.getByRole('button', { name: /Time/ }));
    expect(timeSort()).toBe('descending');
    rerender(tab(next));
    expect(timeSort()).toBe('ascending');
  });
});
