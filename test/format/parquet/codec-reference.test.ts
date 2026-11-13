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
import { assertInt32Offset, encodeColumnsUnfiltered } from '../../../src/format/parquet/codec.js';
import {
  type ColumnDef,
  SORT_COLUMNS,
  TABLE_COLUMNS,
  TABLES,
  type Table,
} from '../../../src/format/parquet/columns.js';
import type { Row } from '../../../src/format/parquet/rows.js';
import { arrowSchema } from '../../../src/format/parquet/schema.js';
import { ensureParquetWasm } from '../../../src/format/parquet/wasm.js';

const OBS = 'observed_time_unix_nano';
const ROW_GROUP_ROWS = 7; // several row groups per file

/** mulberry32: a small seeded generator, so a failure is reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Small pools, so sort keys tie often; the strings mix empty, ASCII, accents, CJK and emoji.
const STRINGS = ['', 'a', 'b', 'é', '日本', '😀', 'svc-é-日本', 'x'.repeat(300)];
const INT32S = [0, 1, -1, 2 ** 31 - 1, -(2 ** 31)];
const INT64S = [0n, 1n, 2n, -5n, 2n ** 63n - 1n, -(2n ** 63n)];
const FLOATS = [0, -0, 1.5, -2.25, Number.NaN, Number.POSITIVE_INFINITY];

function cell(def: ColumnDef, r: () => number): unknown {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  switch (def.type) {
    case 'utf8':
    case 'json':
      return pick(STRINGS);
    case 'int32':
      return pick(INT32S);
    case 'int64':
      return pick(INT64S);
    case 'float64':
      return pick(FLOATS);
    case 'bool':
      return r() < 0.5;
    case 'list_float64':
      return Array.from({ length: Math.floor(r() * 4) }, () => pick(FLOATS));
    case 'list_int64':
      return Array.from({ length: Math.floor(r() * 4) }, () => pick(INT64S));
  }
}

function rowsOf(table: Table, seed: number, count: number): Row[] {
  const r = rng(seed);
  return Array.from({ length: count }, () => {
    const row: Row = {};
    for (const def of TABLE_COLUMNS[table]) {
      const missing = def.nullable && r() < 0.25;
      if (!missing) row[def.name] = cell(def, r);
      else if (r() < 0.5) row[def.name] = null;
    }
    return row;
  });
}

/** The encoder `encodeColumns` replaced: Arrow builders over rows sorted by `Array.prototype.sort`. */
function reference(table: Table, rows: readonly Row[]): Uint8Array {
  const cmp = (a: unknown, b: unknown): number => {
    if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
    return (a as bigint | string) < (b as bigint | string)
      ? -1
      : (a as bigint | string) > (b as bigint | string)
        ? 1
        : 0;
  };
  const key = (row: Row, c: string): unknown =>
    row[c] ?? (table === 'logs' && c === 'time_unix_nano' ? row[OBS] : null);
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
        sorted.map((row) => row[def.name] ?? null),
        field.type,
      ).data,
    );
  }
  const arrow =
    sorted.length === 0
      ? new ArrowTable(schema)
      : new ArrowTable(
          schema,
          new RecordBatch(
            schema,
            makeData({ type: new Struct(schema.fields), length: sorted.length, nullCount: 0, children }),
          ),
        );
  ensureParquetWasm();
  return writeParquet(
    WasmTable.fromIPCStream(tableToIPC(arrow, 'stream')),
    new WriterPropertiesBuilder().setCompression(Compression.ZSTD).setMaxRowGroupSize(ROW_GROUP_ROWS).build(),
  );
}

describe('encodeColumnsUnfiltered against the Arrow-builder encoder', () => {
  for (const table of TABLES) {
    test(`${table}: seeded rows with ties, nulls, non-ASCII, lists and dictionaries are byte-identical`, () => {
      for (let seed = 1; seed <= 12; seed++) {
        const rows = rowsOf(table, seed * 7919, seed === 1 ? 0 : seed * 5);
        const got = encodeColumnsUnfiltered(table, batchFromRows(table, rows), {
          rowGroupRows: ROW_GROUP_ROWS,
        });
        expect(Buffer.from(got).equals(Buffer.from(reference(table, rows))), `seed ${seed}`).toBe(true);
      }
    });
  }

  test('logs sort by observed time when time is missing', () => {
    const rows: Row[] = [
      { time_unix_nano: null, [OBS]: 5n, body: 'a' },
      { time_unix_nano: 3n, body: 'b' },
      { body: 'c' },
    ];
    const got = encodeColumnsUnfiltered('logs', batchFromRows('logs', rows), {
      rowGroupRows: ROW_GROUP_ROWS,
    });
    expect(Buffer.from(got).equals(Buffer.from(reference('logs', rows)))).toBe(true);
  });
});

describe('assertInt32Offset', () => {
  test('passes up to the limit and throws one past it, naming the column', () => {
    expect(() => assertInt32Offset(10, 'body', 10)).not.toThrow();
    expect(() => assertInt32Offset(11, 'body', 10)).toThrowError(/body/);
    expect(() => assertInt32Offset(2 ** 31 - 1, 'body')).not.toThrow();
    expect(() => assertInt32Offset(2 ** 31, 'body')).toThrow();
  });
});
