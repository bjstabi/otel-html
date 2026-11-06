import {
  Table as ArrowTable,
  type Data,
  makeData,
  RecordBatch,
  Struct,
  tableFromIPC,
  tableToIPC,
  type Vector,
  vectorFromArray,
} from 'apache-arrow';
import {
  Compression,
  readParquet,
  Table as WasmTable,
  WriterPropertiesBuilder,
  writeParquet,
} from 'parquet-wasm/esm';
import { OtelHtmlError } from '../../model/errors.js';
import type { Row } from './rows.js';
import { arrowSchema, type ColumnType, SORT_COLUMNS, TABLE_COLUMNS, type Table } from './schema.js';
import { ensureParquetWasm } from './wasm.js';

export interface EncodeOptions {
  readonly rowGroupRows: number;
}

const OBSERVED = 'observed_time_unix_nano';

/** The value a column is sorted by; logs sort by `time_unix_nano ?? observed_time_unix_nano` (the column keeps its null). */
function sortKey(table: Table, row: Row, column: string): unknown {
  const v = row[column];
  if (v !== undefined && v !== null) return v;
  if (table === 'logs' && column === 'time_unix_nano') return row[OBSERVED] ?? null;
  return null;
}

function compareKeys(a: unknown, b: unknown): number {
  const aNull = a === undefined || a === null;
  const bNull = b === undefined || b === null;
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1; // nulls last
  return (a as string | bigint | number) < (b as string | bigint | number)
    ? -1
    : (a as string | bigint | number) > (b as string | bigint | number)
      ? 1
      : 0;
}

function sortedRows(table: Table, rows: readonly Row[]): Row[] {
  const columns = SORT_COLUMNS[table];
  // Array.prototype.sort is stable.
  return [...rows].sort((x, y) => {
    for (const c of columns) {
      const d = compareKeys(sortKey(table, x, c), sortKey(table, y, c));
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

/**
 * Throws `invalid-report` unless `row` holds only columns of `table`, a value in every non-nullable column, and for
 * every cell the JS type and range its column stores. `encodeTable` runs it on every row; a session runs it on rows
 * it is about to accept, so a row that cannot be encoded never reaches a cut. `index` names the row in the error.
 */
export function checkRow(table: Table, row: Row, index = 0): void {
  const columns = TABLE_COLUMNS[table];
  for (const k of Object.keys(row)) {
    if (!columns.some((c) => c.name === k))
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

/** Sorts `rows` by `SORT_COLUMNS[table]` (nulls last, stable) and encodes them as ZSTD Parquet. */
export function encodeTable(table: Table, rows: readonly Row[], opts: EncodeOptions): Uint8Array {
  // Validate in the caller's row order, so the row index in an error is the caller's.
  for (const [r, row] of rows.entries()) checkRow(table, row, r);
  const sorted = sortedRows(table, rows);
  const schema = arrowSchema(table);
  const children: Data[] = [];
  for (const [i, def] of TABLE_COLUMNS[table].entries()) {
    const field = schema.fields[i];
    if (field === undefined) throw new Error(`no arrow field for ${table}.${def.name}`);
    const values = sorted.map((r) => r[def.name] ?? null);
    const vector = vectorFromArray(values, field.type);
    children.push(...vector.data);
  }
  const type = new Struct(schema.fields);
  const arrow =
    sorted.length === 0
      ? new ArrowTable(schema)
      : new ArrowTable(
          schema,
          new RecordBatch(schema, makeData({ type, length: sorted.length, nullCount: 0, children })),
        );
  ensureParquetWasm();
  const wasm = WasmTable.fromIPCStream(tableToIPC(arrow, 'stream'));
  const props = new WriterPropertiesBuilder()
    .setCompression(Compression.ZSTD)
    .setMaxRowGroupSize(opts.rowGroupRows)
    .build();
  return writeParquet(wasm, props);
}

function plain(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && 'toArray' in value) {
    return Array.from((value as Vector).toArray() as ArrayLike<unknown>);
  }
  return value;
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
