import { describe, expect, test } from 'vitest';
import { attributesToJson } from '../../src/format/columns.js';
import { batchFromRows } from '../../src/format/parquet/batch.js';
import type { Row } from '../../src/format/parquet/rows.js';
import {
  logRollupRows,
  RollupSum,
  rollupAllowed,
  rollupDimensions,
  rollupSumsFit,
  spanRollupRows,
  widestDimension,
} from '../../src/writer/rollup-rows.js';

const get = (r: Row, k: string): unknown => Reflect.get(r, k);
const GRAIN = 65_536_000_000n;
const T0 = 10n * GRAIN;

function spanRow(over: Row = {}): Row {
  return {
    trace_id: 't',
    span_id: 's',
    name: 'op',
    start_time_unix_nano: T0 + 5n,
    end_time_unix_nano: T0 + 1_005n,
    duration_ns: 1_000n,
    service_name: 'svc',
    scope_name: 'sc',
    kind: 1,
    status_code: 0,
    resource_name: 'svc',
    ...over,
  };
}

const attrs = (entries: [string, { kind: 'string'; value: string } | { kind: 'int'; value: bigint }][]) =>
  attributesToJson(new Map(entries));

const dims = rollupDimensions('spans', ['attr:http.method']);

describe('rollupDimensions', () => {
  test('core columns, core resource keys and the attr/resource statistics keys, sorted', () => {
    expect(rollupDimensions('spans', ['name', 'attr:b', 'resource:a', 'trace_id'])).toEqual([
      'attr:b',
      'kind',
      'name',
      'resource:a',
      'resource:deployment.environment.name',
      'resource:host.name',
      'resource:service.name',
      'resource_name',
      'scope_name',
      'service_name',
      'status_code',
    ]);
    expect(rollupDimensions('logs', [])).toEqual([
      'event_name',
      'has_trace',
      'host_name',
      'resource:service.name',
      'scope_name',
      'service_name',
      'severity_number',
    ]);
  });
});

describe('spanRollupRows', () => {
  test('three spans of one grain, dimensions and bucket make one row', () => {
    const spans = batchFromRows('spans', [
      spanRow({ duration_ns: 1_000n }),
      spanRow({ duration_ns: 1_010n }),
      spanRow({ duration_ns: 1_020n }),
    ]);
    expect(spanRollupRows(spans, dims)).toEqual([
      expect.objectContaining({
        n: 3n,
        duration_bucket: 79,
        duration_sum: 3_030n,
        duration_min: 1_000n,
        duration_max: 1_020n,
        start_time_unix_nano: T0,
      }),
    ]);
  });

  test('a span starting exactly on a grain edge belongs to the grain that starts there', () => {
    const spans = batchFromRows('spans', [
      spanRow({ start_time_unix_nano: T0 }),
      spanRow({ start_time_unix_nano: T0 - 1n }),
    ]);
    const rows = spanRollupRows(spans, dims);
    expect(rows.map((r) => get(r, 'start_time_unix_nano')).sort()).toEqual([T0 - GRAIN, T0]);
  });

  test('a value’s kind is kept: "1" and 1 under one key are two rows; an empty string and an absent key are two rows', () => {
    const batch = batchFromRows('spans', [
      spanRow({ attributes: attrs([['http.method', { kind: 'string', value: '1' }]]) }),
      spanRow({ attributes: attrs([['http.method', { kind: 'int', value: 1n }]]) }),
      spanRow({ attributes: attrs([['http.method', { kind: 'string', value: '' }]]) }),
      spanRow({ attributes: attrs([['other', { kind: 'string', value: 'x' }]]) }),
    ]);
    const rows = spanRollupRows(batch, dims);
    expect(rows.map((r) => get(r, 'attributes')).sort()).toEqual([
      '{"http.method":""}',
      '{"http.method":"1"}',
      '{"http.method":1}',
      '{}',
    ]);
    expect(rows.every((r) => get(r, 'n') === 1n)).toBe(true);
  });

  test('a duration of zero is bucket -1 with duration_sum 0', () => {
    const rows = spanRollupRows(batchFromRows('spans', [spanRow({ duration_ns: 0n })]), dims);
    expect(rows).toEqual([expect.objectContaining({ duration_bucket: -1, duration_sum: 0n, n: 1n })]);
  });

  test('widestDimension names the dimension with the most distinct values', () => {
    const rows = spanRollupRows(
      batchFromRows(
        'spans',
        ['a', 'b', 'c'].map((name, i) => spanRow({ name, service_name: i === 0 ? 'x' : 'y' })),
      ),
      dims,
    );
    expect(widestDimension(rows, dims)).toEqual({ dimension: 'name', distinct: 3 });
  });
});

describe('logRollupRows', () => {
  test('a log with no time has a null grain; a log with only an observed time uses it', () => {
    const log = (over: Row): Row => ({ severity_number: 9, service_name: 'svc', ...over });
    const rows = logRollupRows(
      batchFromRows('logs', [
        log({}),
        log({ observed_time_unix_nano: T0 + 7n }),
        log({ time_unix_nano: T0 + 9n, observed_time_unix_nano: T0 + GRAIN }),
      ]),
      rollupDimensions('logs', []),
    );
    const byGrain = rows.map((r) => [get(r, 'time_unix_nano'), get(r, 'n')]);
    expect(byGrain).toEqual([
      [null, 1n],
      [T0, 2n],
    ]);
    expect(rows.every((r) => get(r, 'observed_time_unix_nano') === null)).toBe(true);
  });

  test('has_trace tells a log with a trace id from one without', () => {
    const rows = logRollupRows(
      batchFromRows('logs', [{ time_unix_nano: T0, trace_id: 'abc' }, { time_unix_nano: T0 }]),
      rollupDimensions('logs', []),
    );
    expect(rows.map((r) => get(r, 'has_trace')).sort()).toEqual([false, true]);
  });
});

describe('rollupAllowed', () => {
  test('boundaries', () => {
    expect([rollupAllowed(4096, 10), rollupAllowed(4097, 32_768), rollupAllowed(4097, 32_776)]).toEqual([
      true,
      false,
      true,
    ]);
  });
});

describe('RollupSum with a limit', () => {
  const row = (name: string): Row => ({ name, n: 1n, duration_sum: 1n, duration_min: 1n, duration_max: 1n });

  test('stops adding and drops its groups once the group count passes the limit', () => {
    const sum = new RollupSum(2);
    sum.add([row('a'), row('b')]);
    expect(sum.exceeded).toBe(false);
    expect(sum.size).toBe(2);
    sum.add([row('c'), row('d')]);
    expect(sum.exceeded).toBe(true);
    expect(sum.size).toBe(0);
    sum.add([row('e')]);
    expect(sum.size).toBe(0);
  });

  test('rows folding into existing groups do not count against the limit', () => {
    const sum = new RollupSum(1);
    sum.add([row('a'), row('a'), row('a')]);
    expect(sum.exceeded).toBe(false);
    expect(sum.rows()).toHaveLength(1);
  });
});

describe('rollupSumsFit', () => {
  const sumRow = (v: bigint | null): Row => ({ duration_sum: v });
  test('accepts the int64 range and refuses outside it; log rows (no sum) fit', () => {
    expect(rollupSumsFit([sumRow(2n ** 63n - 1n), sumRow(-(2n ** 63n)), sumRow(null), {}])).toBe(true);
    expect(rollupSumsFit([sumRow(2n ** 63n)])).toBe(false);
    expect(rollupSumsFit([sumRow(-(2n ** 63n) - 1n)])).toBe(false);
  });
});
