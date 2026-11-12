import {
  Table as ArrowTable,
  Bool,
  type Data,
  type DataType,
  Field,
  Float64,
  Int32,
  Int64,
  List,
  makeData,
  makeVector,
  RecordBatch,
  Struct,
  tableFromIPC,
  tableToIPC,
  Utf8,
  type Vector,
} from 'apache-arrow';
import {
  Compression,
  readParquet,
  Table as WasmTable,
  type WriterProperties,
  WriterPropertiesBuilder,
  writeParquet,
} from 'parquet-wasm/esm';
import { OtelHtmlError } from '../../model/errors.js';
import { batchFromRows, type ColumnBatch } from './batch.js';
import { addBloomFilters, BLOOM_COLUMN, BLOOM_TABLES, BloomCollector } from './bloom.js';
import {
  type ColumnDef,
  type ColumnType,
  SORT_COLUMNS,
  TABLE_COLUMNS,
  TABLES,
  type Table,
} from './columns.js';
import type { Row } from './rows.js';
import { arrowSchema } from './schema.js';
import { ensureParquetWasm } from './wasm.js';

export interface EncodeOptions {
  readonly rowGroupRows: number;
}

const OBSERVED = 'observed_time_unix_nano';

export function compareKeys(a: unknown, b: unknown): number {
  const aNull = a === undefined || a === null;
  const bNull = b === undefined || b === null;
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1; // nulls last
  return (a as string | bigint | number) < (b as string | bigint | number)
    ? -1
    : (a as string | bigint | number) > (b as string | bigint | number)
      ? 1
      : 0;
}

/**
 * The sort key of one row, `get` reading its cells by column name: `SORT_COLUMNS[table]`, with logs' time falling back
 * to the observed time. Compare keys element by element with `compareKeys`. `sortPermutation` below sorts by the
 * same key a column at a time.
 */
export function sortKeyOf(table: Table, get: (column: string) => unknown): unknown[] {
  return SORT_COLUMNS[table].map((c) =>
    table === 'logs' && c === 'time_unix_nano' ? (get(c) ?? get(OBSERVED) ?? null) : (get(c) ?? null),
  );
}

/**
 * The stable permutation that sorts a batch by `SORT_COLUMNS[table]` (nulls last); logs sort by
 * `time_unix_nano ?? observed_time_unix_nano` (the column keeps its null).
 */
function sortPermutation(table: Table, batch: ColumnBatch): number[] {
  const keys = SORT_COLUMNS[table].map((c): readonly unknown[] => {
    const col = batch.cells[c] ?? [];
    if (!(table === 'logs' && c === 'time_unix_nano')) return col;
    const observed = batch.cells[OBSERVED] ?? [];
    return col.map((v, i) => v ?? observed[i] ?? null);
  });
  const order = Array.from({ length: batch.length }, (_, i) => i);
  // Array.prototype.sort is stable.
  return order.sort((x, y) => {
    for (const k of keys) {
      const d = compareKeys(k[x], k[y]);
      if (d !== 0) return d;
    }
    return 0;
  });
}

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Whether a non-null cell has the JS type (and range) its column type stores; the one pass `encodeTable` makes. */
function cellFits(type: ColumnType, v: unknown): boolean {
  switch (type) {
    case 'utf8':
    case 'json':
      return typeof v === 'string';
    case 'int32':
      return typeof v === 'number' && Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX;
    case 'int64':
      return typeof v === 'bigint' && v >= INT64_MIN && v <= INT64_MAX;
    case 'float64':
      return typeof v === 'number';
    case 'bool':
      return typeof v === 'boolean';
    case 'list_float64':
      return Array.isArray(v) && v.every((x) => typeof x === 'number');
    case 'list_int64':
      return Array.isArray(v) && v.every((x) => typeof x === 'bigint' && x >= INT64_MIN && x <= INT64_MAX);
  }
}

function invalidCell(path: string, expected: string, actual: string): OtelHtmlError {
  return new OtelHtmlError('invalid-report', { path, expected, actual });
}

const COLUMN_NAMES = new Map<Table, ReadonlySet<string>>(
  TABLES.map((t) => [t, new Set(TABLE_COLUMNS[t].map((c) => c.name))]),
);

/**
 * Throws `invalid-report` unless `row` holds only columns of `table`, a value in every non-nullable column, and for
 * every cell the JS type and range its column stores. `encodeTable` runs it on every row; a session runs it on rows
 * it is about to accept, so a row that cannot be encoded never reaches a cut. `index` names the row in the error.
 */
export function checkRow(table: Table, row: Row, index = 0): void {
  const columns = TABLE_COLUMNS[table];
  for (const k of Object.keys(row)) {
    if (!COLUMN_NAMES.get(table)?.has(k))
      throw invalidCell(`${table}.${k}`, 'a column of the table', `unknown column in row ${index}`);
  }
  for (const def of columns) {
    const v = row[def.name] ?? null;
    if (v === null) {
      if (!def.nullable) {
        throw invalidCell(
          `${table}.${def.name}`,
          'a value in a non-nullable column',
          `null or missing in row ${index}`,
        );
      }
    } else if (!cellFits(def.type, v)) {
      throw invalidCell(`${table}.${def.name}`, `a ${def.type} value`, `${typeof v} in row ${index}`);
    }
  }
}

interface Cells {
  readonly name: string;
  readonly col: readonly unknown[];
  readonly perm: readonly number[];
  readonly valid: Uint8Array;
  nullCount: number;
}

function setValid(c: Cells, i: number): void {
  c.valid[i >> 3] = (c.valid[i >> 3] ?? 0) | (1 << (i & 7));
}

function validity(c: Cells, length: number): { nullCount: number; nullBitmap?: Uint8Array } {
  return c.nullCount === 0 || length === 0
    ? { nullCount: 0 }
    : { nullCount: c.nullCount, nullBitmap: c.valid };
}

/** A fixed-width column: `fill` stores each non-null cell of the permuted column into the typed array. */
function fixedData<T extends Float64Array | Int32Array | BigInt64Array>(
  type: DataType,
  c: Cells,
  data: T,
  put: (data: T, i: number, v: unknown) => void,
): Data {
  const n = c.perm.length;
  for (let i = 0; i < n; i++) {
    const v = c.col[c.perm[i] ?? 0] ?? null;
    if (v === null) c.nullCount++;
    else {
      setValid(c, i);
      put(data, i, v);
    }
  }
  return makeData({ type, length: n, data, ...validity(c, n) } as Parameters<typeof makeData>[0]);
}

/**
 * Arrow offsets are Int32: a column of strings or list items past 2^31-1 would wrap into negative offsets and
 * corrupt the file, so it is an error. `limit` is a parameter so a test can hit it without allocating 2 GiB.
 */
export function assertInt32Offset(next: number, column: string, limit: number = INT32_MAX): void {
  if (next > limit) {
    throw invalidCell(
      column,
      'a column under 2 GiB (Int32 offsets)',
      `${next} bytes or items; lower writer.chunkTargetBytes`,
    );
  }
}

const ENCODER = new TextEncoder();

/** UTF-8 bytes and Int32 offsets of the permuted strings (null cells are empty), written in one `encodeInto` pass. */
function utf8Buffers(c: Cells): { offsets: Int32Array; bytes: Uint8Array } {
  const n = c.perm.length;
  const offsets = new Int32Array(n + 1);
  let chars = 0;
  for (let i = 0; i < n; i++) {
    const v = c.col[c.perm[i] ?? 0];
    if (typeof v === 'string') chars += v.length;
  }
  let bytes = new Uint8Array(Math.max(chars, 8));
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const v = c.col[c.perm[i] ?? 0] ?? null;
    if (typeof v === 'string') {
      setValid(c, i);
      if (pos + v.length * 3 > bytes.length) {
        // Grow only when the worst case (3 bytes per UTF-16 unit) might not fit.
        const need = ENCODER.encode(v).length;
        if (pos + need > bytes.length) {
          const grown = new Uint8Array(Math.max(bytes.length * 2, pos + need));
          grown.set(bytes.subarray(0, pos));
          bytes = grown;
        }
      }
      pos += ENCODER.encodeInto(v, bytes.subarray(pos)).written;
    } else c.nullCount++;
    assertInt32Offset(pos, c.name);
    offsets[i + 1] = pos;
  }
  return { offsets, bytes: bytes.subarray(0, pos) };
}

function utf8Data(c: Cells): Data {
  const n = c.perm.length;
  const { offsets, bytes } = utf8Buffers(c);
  return makeData({ type: new Utf8(), length: n, valueOffsets: offsets, data: bytes, ...validity(c, n) });
}

/** A dictionary column: indices in first-appearance order of the permuted values, like Arrow's dictionary builder. */
function dictionaryData(c: Cells, type: DataType): Data {
  const n = c.perm.length;
  const index = new Map<string, number>();
  const indices = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const v = c.col[c.perm[i] ?? 0] ?? null;
    if (typeof v !== 'string') {
      c.nullCount++;
      continue;
    }
    setValid(c, i);
    let k = index.get(v);
    if (k === undefined) {
      k = index.size;
      index.set(v, k);
    }
    indices[i] = k;
  }
  const words = [...index.keys()];
  const dict = utf8Data({
    name: c.name,
    col: words,
    perm: words.map((_, i) => i),
    valid: new Uint8Array((words.length + 7) >> 3),
    nullCount: 0,
  });
  return makeData({
    type,
    length: n,
    data: indices,
    dictionary: makeVector(dict),
    ...validity(c, n),
  } as Parameters<typeof makeData>[0]);
}

function listData(c: Cells, item: 'float64' | 'int64'): Data {
  const n = c.perm.length;
  const offsets = new Int32Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const v = c.col[c.perm[i] ?? 0] ?? null;
    if (Array.isArray(v)) total += v.length;
    assertInt32Offset(total, c.name);
    offsets[i + 1] = total;
  }
  const f64 = new Float64Array(item === 'float64' ? total : 0);
  const i64 = new BigInt64Array(item === 'int64' ? total : 0);
  for (let i = 0; i < n; i++) {
    const v = c.col[c.perm[i] ?? 0] ?? null;
    if (!Array.isArray(v)) {
      c.nullCount++;
      continue;
    }
    setValid(c, i);
    const at = offsets[i] ?? 0;
    for (const [j, x] of v.entries()) {
      if (item === 'float64') f64[at + j] = x as number;
      else i64[at + j] = x as bigint;
    }
  }
  const itemType = item === 'float64' ? new Float64() : new Int64();
  const child = makeData({
    type: itemType,
    length: total,
    data: item === 'float64' ? f64 : i64,
  } as Parameters<typeof makeData>[0]);
  return makeData({
    type: new List(new Field('item', itemType, true)),
    length: n,
    valueOffsets: offsets,
    child,
    ...validity(c, n),
  } as Parameters<typeof makeData>[0]);
}

function boolData(c: Cells): Data {
  const n = c.perm.length;
  const bits = new Uint8Array((n + 7) >> 3);
  for (let i = 0; i < n; i++) {
    const v = c.col[c.perm[i] ?? 0] ?? null;
    if (v === null) c.nullCount++;
    else {
      setValid(c, i);
      if (v === true) bits[i >> 3] = (bits[i >> 3] ?? 0) | (1 << (i & 7));
    }
  }
  return makeData({ type: new Bool(), length: n, data: bits, ...validity(c, n) });
}

/** One column's Arrow data, filled in `perm` order straight from the column array. */
function columnData(def: ColumnDef, type: DataType, col: readonly unknown[], perm: readonly number[]): Data {
  const n = perm.length;
  const c: Cells = { name: def.name, col, perm, valid: new Uint8Array((n + 7) >> 3), nullCount: 0 };
  switch (def.type) {
    case 'utf8':
    case 'json':
      return def.dictionary ? dictionaryData(c, type) : utf8Data(c);
    case 'int32':
      return fixedData(new Int32(), c, new Int32Array(n), (d, i, v) => {
        d[i] = v as number;
      });
    case 'float64':
      return fixedData(new Float64(), c, new Float64Array(n), (d, i, v) => {
        d[i] = v as number;
      });
    case 'int64':
      return fixedData(new Int64(), c, new BigInt64Array(n), (d, i, v) => {
        d[i] = v as bigint;
      });
    case 'bool':
      return boolData(c);
    case 'list_float64':
      return listData(c, 'float64');
    case 'list_int64':
      return listData(c, 'int64');
  }
}

/**
 * Sorts a batch by `SORT_COLUMNS[table]` (nulls last, stable) and encodes it as ZSTD Parquet, with a bloom filter on
 * `trace_id` in every row group of `traces` and `logs` (see `bloom.ts`). It does not check the cells: every
 * row must have passed `checkRow` (a session checks each row when it accepts it; `encodeTable` checks).
 */
export function encodeColumns(table: Table, batch: ColumnBatch, opts: EncodeOptions): Uint8Array {
  const perm = sortPermutation(table, batch);
  const file = encodeSorted(table, batch, perm, opts);
  if (!BLOOM_TABLES.has(table) || batch.length === 0) return file;
  const collector = new BloomCollector(opts.rowGroupRows);
  const ids = batch.cells[BLOOM_COLUMN] ?? [];
  collector.add(perm.map((i) => ids[i]));
  return addBloomFilters(file, collector.finish());
}

/** `encodeColumns` without the bloom filters: what `encodeBatches` streams, and what a file written before them is. */
export function encodeColumnsUnfiltered(table: Table, batch: ColumnBatch, opts: EncodeOptions): Uint8Array {
  return encodeSorted(table, batch, sortPermutation(table, batch), opts);
}

function encodeSorted(
  table: Table,
  batch: ColumnBatch,
  perm: readonly number[],
  opts: EncodeOptions,
): Uint8Array {
  const arrow = columnsToArrow(table, batch, perm);
  ensureParquetWasm();
  const wasm = WasmTable.fromIPCStream(tableToIPC(arrow, 'stream'));
  return writeParquet(wasm, writerProperties(opts));
}

/** The Arrow table of a batch, its rows in `perm` order (every row once). No sorting and no cell checks. */
export function columnsToArrow(table: Table, batch: ColumnBatch, perm: readonly number[]): ArrowTable {
  const schema = arrowSchema(table);
  const children: Data[] = [];
  for (const [i, def] of TABLE_COLUMNS[table].entries()) {
    const field = schema.fields[i];
    if (field === undefined) throw new Error(`no arrow field for ${table}.${def.name}`);
    children.push(columnData(def, field.type, batch.cells[def.name] ?? [], perm));
  }
  const type = new Struct(schema.fields);
  return batch.length === 0
    ? new ArrowTable(schema)
    : new ArrowTable(
        schema,
        new RecordBatch(schema, makeData({ type, length: batch.length, nullCount: 0, children })),
      );
}

/** ZSTD, row groups of `rowGroupRows`: the one set of properties every format-4 file is written with. */
export function writerProperties(opts: EncodeOptions): WriterProperties {
  ensureParquetWasm();
  return new WriterPropertiesBuilder()
    .setCompression(Compression.ZSTD)
    .setMaxRowGroupSize(opts.rowGroupRows)
    .build();
}

/** Sorts `rows` by `SORT_COLUMNS[table]` (nulls last, stable) and encodes them as ZSTD Parquet. */
export function encodeTable(table: Table, rows: readonly Row[], opts: EncodeOptions): Uint8Array {
  // Validate in the caller's row order, so the row index in an error is the caller's.
  for (const [r, row] of rows.entries()) checkRow(table, row, r);
  return encodeColumns(table, batchFromRows(table, rows), opts);
}

function plain(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && 'toArray' in value) {
    return Array.from((value as Vector).toArray() as ArrayLike<unknown>);
  }
  return value;
}

/** One Arrow record batch as one JS array per column (`null` for a null; dictionaries as strings, lists as arrays). */
export function columnsOfBatch(
  batch: { numRows: number; getChildAt(i: number): Vector | null },
  width: number,
): unknown[][] {
  const out: unknown[][] = [];
  for (let c = 0; c < width; c++) {
    const vec = batch.getChildAt(c);
    const col: unknown[] = new Array<unknown>(batch.numRows);
    for (let i = 0; i < batch.numRows; i++) col[i] = plain(vec?.get(i));
    out.push(col);
  }
  return out;
}

/** Decodes a partition file into rows: every schema column is present, `null` for a null; dictionaries as strings. */
export function decodeTable(_table: Table, bytes: Uint8Array): Row[] {
  ensureParquetWasm();
  const arrow = tableFromIPC(readParquet(bytes).intoIPCStream());
  const names = arrow.schema.fields.map((f) => f.name);
  const rows: Row[] = [];
  for (const batch of arrow.batches) {
    for (let i = 0; i < batch.numRows; i++) {
      const row: Row = {};
      for (const [c, name] of names.entries()) row[name] = plain(batch.getChildAt(c)?.get(i));
      rows.push(row);
    }
  }
  return rows;
}
