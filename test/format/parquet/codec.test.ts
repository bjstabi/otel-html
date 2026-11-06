import { describe, expect, test } from 'vitest';
import { decodeTable, encodeTable } from '../../../src/format/parquet/codec.js';
import type { Row } from '../../../src/format/parquet/rows.js';
import { parquetMetadata } from '../../../test-support/parquet-metadata.js';

const SPAN_ID = 'span_id';
const opts = { rowGroupRows: 50_000 };

function span(i: number, scope: string, service: string, start: bigint): Row {
  return {
    trace_id: `t${i}`,
    span_id: `s${i}`,
    name: `op${i % 7}`,
    start_time_unix_nano: start,
    end_time_unix_nano: start + 10n,
    duration_ns: 10n,
    attributes: '{"a":1}',
    scope_name: scope,
    service_name: service,
  };
}

/** `decodeTable` returns every column of the schema; absent nullable keys come back as explicit nulls. */
function withNulls(row: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const k of keys) out[k] = row[k] ?? null;
  return out;
}

function get(row: Row | undefined, key: string): unknown {
  return row?.[key];
}

function manySpans(n: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(span(i, `scope${i % 3}`, `svc${i % 5}`, 1_700_000_000_000_000_000n + BigInt(n - i)));
  }
  return rows;
}

describe('parquet codec', () => {
  test('encode then decode is the identity after sorting', () => {
    const rows = [span(1, 'b', 'x', 5n), span(2, 'a', 'y', 9n), span(3, 'a', 'x', 7n), span(4, 'a', 'x', 3n)];
    const decoded = decodeTable('spans', encodeTable('spans', rows, opts));
    expect(decoded.map((r) => get(r, 'span_id'))).toEqual(['s4', 's3', 's2', 's1']);
    const keys = Object.keys(decoded[0] ?? {});
    expect(keys).toContain('parent_span_id');
    const sorted = [rows[3], rows[2], rows[1], rows[0]] as Row[];
    expect(decoded).toEqual(sorted.map((r) => withNulls(r, keys)));
    expect(get(decoded[0], 'parent_span_id')).toBeNull();
    expect(typeof get(decoded[0], 'start_time_unix_nano')).toBe('bigint');
  });

  test('lists, booleans, doubles and int32 round-trip', () => {
    const row: Row = {
      metric_name: 'm',
      point_type: 'histogram',
      time_unix_nano: 2n ** 62n + 1n,
      series_id: 'x',
      is_monotonic: true,
      sum: 1.5,
      scale: -3,
      explicit_bounds: [0.5, Number.POSITIVE_INFINITY],
      bucket_counts: [1n, 2n ** 60n, 0n],
      scope_name: 's',
    };
    const [out] = decodeTable('points', encodeTable('points', [row], opts));
    expect(out).toMatchObject(row);
    expect(get(out, 'positive_counts')).toBeNull();
  });

  test('the sort is stable and puts nulls last', () => {
    const base = { trace_id: 't', name: 'n', end_time_unix_nano: 1n, duration_ns: 1n };
    const rows: Row[] = [
      { ...base, span_id: '1', start_time_unix_nano: 1n, service_name: 'a' },
      { ...base, span_id: '2', start_time_unix_nano: 1n, scope_name: 'z', service_name: 'a' },
      { ...base, span_id: '3', start_time_unix_nano: 1n, scope_name: 'a', service_name: 'a' },
      { ...base, span_id: '4', start_time_unix_nano: 1n, service_name: 'a' },
      { ...base, span_id: '5', start_time_unix_nano: 1n, scope_name: 'a', service_name: 'a' },
    ];
    const out = decodeTable('spans', encodeTable('spans', rows, opts));
    expect(out.map((r) => get(r, 'span_id'))).toEqual(['3', '5', '2', '1', '4']);
  });

  test('logs sort by the effective time, observed time standing in for a null time', () => {
    const rows: Row[] = [
      { time_unix_nano: 30n, observed_time_unix_nano: 1n, body: '"c"' },
      { observed_time_unix_nano: 10n, body: '"a"' },
      { time_unix_nano: 20n, observed_time_unix_nano: 99n, body: '"b"' },
      { body: '"none"' },
    ];
    const out = decodeTable('logs', encodeTable('logs', rows, opts));
    expect(out.map((r) => get(r, 'body'))).toEqual(['"a"', '"b"', '"c"', '"none"']);
    expect(get(out[0], 'time_unix_nano')).toBeNull();
  });

  test('ZSTD and row groups are what the options say', async () => {
    const bytes = encodeTable('spans', manySpans(120_000), opts);
    const meta = await parquetMetadata(bytes);
    expect(new Set(meta.map((m) => m.compression))).toEqual(new Set(['ZSTD']));
    expect(new Set(meta.map((m) => m.row_group_id)).size).toBe(3);
    const scope = meta
      .filter((m) => m.path_in_schema === 'scope_name')
      .sort((a, b) => a.row_group_id - b.row_group_id);
    expect(scope.map((m) => m.row_group_num_rows)).toEqual([50_000, 50_000, 20_000]);
    // sorted by scope_name: scope0 fills rows 0-39999, scope1 the next 40000, scope2 the rest
    expect(scope.map((m) => m.stats_min_value)).toEqual(['scope0', 'scope1', 'scope2']);
    expect(scope.map((m) => m.stats_max_value)).toEqual(['scope1', 'scope2', 'scope2']);
  });

  test('a missing non-nullable column is an invalid-report error naming the column', () => {
    const bad = span(1, 'a', 'b', 1n);
    delete bad[SPAN_ID];
    expect(() => encodeTable('spans', [bad], opts)).toThrowError(
      expect.objectContaining({ code: 'invalid-report', path: 'spans.span_id' }),
    );
  });

  test('an empty row list encodes to a valid empty table', () => {
    expect(decodeTable('logs', encodeTable('logs', [], opts))).toEqual([]);
  });
});
