import { describe, expect, test } from 'vitest';
import { batchFromRows } from '../../src/format/parquet/batch.js';
import type { Row } from '../../src/format/parquet/rows.js';
import { traceRows as traceRowsOf } from '../../src/writer/trace-summaries.js';

const traceRows = (spans: readonly Row[], logs: readonly Row[]): Row[] =>
  traceRowsOf(batchFromRows('spans', spans), batchFromRows('logs', logs));

function span(trace: string, id: string, start: bigint, end: bigint, extra: Row = {}): Row {
  return {
    trace_id: trace,
    span_id: id,
    parent_span_id: 'p',
    name: `n${id}`,
    start_time_unix_nano: start,
    end_time_unix_nano: end,
    status_code: 0,
    service_name: 'svc',
    resource_name: `r${id}`,
    ...extra,
  };
}

describe('traceRows', () => {
  test('two spans of one trace make one row', () => {
    const rows = traceRows([span('t', 'a', 10n, 20n), span('t', 'b', 5n, 15n)], []);
    expect(rows).toEqual([
      {
        trace_id: 't',
        start_time_unix_nano: 5n,
        end_time_unix_nano: 20n,
        span_count: 2,
        error_count: 0,
        root_service: null,
        root_name: null,
        root_resource: null,
        log_count: 0,
      },
    ]);
  });

  test('the root span promotes its service, name and resource', () => {
    const [row] = traceRows(
      [span('t', 'a', 10n, 20n), span('t', 'r', 5n, 25n, { parent_span_id: null })],
      [],
    );
    expect(row).toMatchObject({ root_service: 'svc', root_name: 'nr', root_resource: 'rr' });
  });

  test('with two roots the earliest start wins, whatever the row order', () => {
    const a = span('t', 'a', 30n, 40n, { parent_span_id: null });
    const b = span('t', 'b', 10n, 20n, { parent_span_id: null });
    expect(Reflect.get(traceRows([a, b], [])[0] ?? {}, 'root_name')).toBe('nb');
    expect(Reflect.get(traceRows([b, a], [])[0] ?? {}, 'root_name')).toBe('nb');
  });

  test('error_count counts status ERROR (2)', () => {
    const rows = traceRows(
      [
        span('t', 'a', 1n, 2n, { status_code: 2 }),
        span('t', 'b', 1n, 2n, { status_code: 1 }),
        span('t', 'c', 1n, 2n, { status_code: 2 }),
      ],
      [],
    );
    expect(Reflect.get(rows[0] ?? {}, 'error_count')).toBe(2);
  });

  test('a trace with only logs has span_count 0, its log count and the log time range', () => {
    const logs: Row[] = [
      { trace_id: 't', time_unix_nano: 50n },
      { trace_id: 't', time_unix_nano: null, observed_time_unix_nano: 40n },
      { trace_id: null, time_unix_nano: 1n },
    ];
    expect(traceRows([], logs)).toEqual([
      expect.objectContaining({
        trace_id: 't',
        span_count: 0,
        log_count: 2,
        start_time_unix_nano: 40n,
        end_time_unix_nano: 50n,
      }),
    ]);
  });

  test('logs add to a span trace without moving its range', () => {
    const [row] = traceRows([span('t', 'a', 10n, 20n)], [{ trace_id: 't', time_unix_nano: 99n }]);
    expect(row).toMatchObject({
      span_count: 1,
      log_count: 1,
      start_time_unix_nano: 10n,
      end_time_unix_nano: 20n,
    });
  });

  test('equal-start roots break on span_id, whatever the row order', () => {
    const a = span('t', 'b', 10n, 20n, { parent_span_id: null });
    const b = span('t', 'a', 10n, 20n, { parent_span_id: null });
    expect(Reflect.get(traceRows([a, b], [])[0] ?? {}, 'root_name')).toBe('na');
    expect(Reflect.get(traceRows([b, a], [])[0] ?? {}, 'root_name')).toBe('na');
  });

  test('a logs-only trace whose logs carry no time has null start and end', () => {
    const [row] = traceRows([], [{ trace_id: 't', time_unix_nano: null, observed_time_unix_nano: null }]);
    expect(row).toMatchObject({ start_time_unix_nano: null, end_time_unix_nano: null, log_count: 1 });
  });
});
