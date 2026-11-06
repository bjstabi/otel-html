import '../../../src/writer/parquet-wasm-source.js';
import {
  Table as ArrowTable,
  type Data,
  makeData,
  RecordBatch,
  Struct,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow';
import { Compression, Table as WasmTable, WriterPropertiesBuilder, writeParquet } from 'parquet-wasm/esm';
import { describe, expect, test } from 'vitest';
import { batchFromRows } from '../../../src/format/parquet/batch.js';
import { encodeColumns } from '../../../src/format/parquet/codec.js';
import type { Row } from '../../../src/format/parquet/rows.js';
import { arrowSchema, SORT_COLUMNS, TABLE_COLUMNS } from '../../../src/format/parquet/schema.js';
import { ensureParquetWasm } from '../../../src/format/parquet/wasm.js';

const OBS = 'observed_time_unix_nano';
const opts = { rowGroupRows: 50_000 };

/** The encoder `encodeColumns` replaced: Arrow builders over the sorted rows. The bytes must not differ. */
function reference(table: 'points' | 'logs', rows: readonly Row[]): Uint8Array {
  const cmp = (a: unknown, b: unknown): number => {
    if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
    return (a as bigint | string) < (b as bigint | string)
      ? -1
      : (a as bigint | string) > (b as bigint | string)
        ? 1
        : 0;
  };
  const key = (r: Row, c: string): unknown =>
    r[c] ?? (table === 'logs' && c === 'time_unix_nano' ? r[OBS] : null);
  const sorted = [...rows].sort((x, y) => {
    for (const c of SORT_COLUMNS[table]) {
      const d = cmp(key(x, c), key(y, c));
      if (d !== 0) return d;
    }
    return 0;
  });
  const schema = arrowSchema(table);
  const children: Data[] = [];
  for (const [i, def] of TABLE_COLUMNS[table].entries()) {
    const field = schema.fields[i];
    if (field === undefined) throw new Error('field');
    children.push(
      ...vectorFromArray(
        sorted.map((r) => r[def.name] ?? null),
        field.type,
      ).data,
    );
  }
  const arrow = new ArrowTable(
    schema,
    new RecordBatch(
      schema,
      makeData({ type: new Struct(schema.fields), length: sorted.length, nullCount: 0, children }),
    ),
  );
  ensureParquetWasm();
  return writeParquet(
    WasmTable.fromIPCStream(tableToIPC(arrow, 'stream')),
    new WriterPropertiesBuilder()
      .setCompression(Compression.ZSTD)
      .setMaxRowGroupSize(opts.rowGroupRows)
      .build(),
  );
}

describe('encodeColumns against the Arrow-builder encoder', () => {
  test('points: every column type, nulls, empty and non-ASCII strings, lists, dictionaries', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push({
        metric_name: `m${i % 3}`,
        point_type: i % 2 ? 'gauge' : 'histogram',
        time_unix_nano: BigInt(100 - i),
        series_id: `s${i}`,
        scope_name: i % 4 === 0 ? null : `sc${i % 2}`,
        service_name: i % 5 === 0 ? '' : 'svc-é-日本',
        attributes: i % 3 ? `{"k":"v${i % 4}"}` : null,
        aggregation_temporality: i % 6 === 0 ? null : i,
        is_monotonic: i % 3 === 0 ? null : i % 2 === 0,
        value_double: i % 7 === 0 ? null : i / 3,
        count: i % 2 ? 2n ** 62n + BigInt(i) : null,
        explicit_bounds: i % 2 ? [0.5, 1.5, i] : i % 3 === 0 ? [] : null,
        bucket_counts: i % 2 ? [1n, -2n, BigInt(i)] : null,
        reset: i % 5 === 0,
        out_of_order: false,
        flags: 0n,
        delta_value: -0,
      });
    }
    const got = encodeColumns('points', batchFromRows('points', rows), opts, { checked: false });
    expect(Buffer.from(got).equals(Buffer.from(reference('points', rows)))).toBe(true);
  });

  test('logs: observed-time fallback, a long string and an empty table', () => {
    const rows: Row[] = [
      { time_unix_nano: null, observed_time_unix_nano: 5n, body: 'x'.repeat(100_000), severity_number: 9 },
      { time_unix_nano: 3n, body: '😀', scope_name: 'a' },
      { body: '' },
    ];
    const got = encodeColumns('logs', batchFromRows('logs', rows), opts, { checked: false });
    expect(Buffer.from(got).equals(Buffer.from(reference('logs', rows)))).toBe(true);
    const none = encodeColumns('logs', batchFromRows('logs', []), opts, { checked: true });
    expect(Buffer.from(none).equals(Buffer.from(reference('logs', [])))).toBe(true);
  });
});
