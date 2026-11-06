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
import parquet from 'parquet-wasm';
import { OtelHtmlError } from '../../model/errors.js';
import type { Row } from './rows.js';
import { arrowSchema, SORT_COLUMNS, TABLE_COLUMNS, type Table } from './schema.js';

export interface EncodeOptions {
  readonly rowGroupRows: number;
}

// parquet-wasm's package `node` condition resolves to its CommonJS build, which loads its WASM synchronously at import.
const { Compression, Table: WasmTable, WriterPropertiesBuilder, readParquet, writeParquet } = parquet;

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

/** Sorts `rows` by `SORT_COLUMNS[table]` (nulls last, stable) and encodes them as ZSTD Parquet. */
export function encodeTable(table: Table, rows: readonly Row[], opts: EncodeOptions): Uint8Array {
  const sorted = sortedRows(table, rows);
  const schema = arrowSchema(table);
  const children: Data[] = [];
  for (const [i, def] of TABLE_COLUMNS[table].entries()) {
    const field = schema.fields[i];
    if (field === undefined) throw new Error(`no arrow field for ${table}.${def.name}`);
    const values = sorted.map((r) => r[def.name] ?? null);
    if (!def.nullable && values.includes(null)) {
      throw new OtelHtmlError('invalid-report', {
        path: `${table}.${def.name}`,
        expected: 'a value in a non-nullable column',
        actual: 'null or missing',
      });
    }
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
