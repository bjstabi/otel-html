import type { Row } from './rows.js';
import { TABLE_COLUMNS, type Table } from './schema.js';

/**
 * Rows of one table as one array per column (`null` for a missing cell), in `TABLE_COLUMNS[table]` order. Holding
 * columns instead of row objects keeps the writer's memory small: a row object per record is promoted garbage.
 */
export interface ColumnBatch {
  readonly length: number;
  readonly cells: Readonly<Record<string, readonly unknown[]>>;
}

/** The arrays a writer appends to; `snapshot` views them as a `ColumnBatch`. */
export type MutableColumns = Record<string, unknown[]>;

export function emptyColumns(table: Table): MutableColumns {
  const cells: MutableColumns = {};
  for (const c of TABLE_COLUMNS[table]) cells[c.name] = [];
  return cells;
}

export function emptyBatch(table: Table): ColumnBatch {
  return { length: 0, cells: emptyColumns(table) };
}

/** Copies one row's cells onto the column arrays (a column the row lacks gets `null`; unknown keys are ignored). */
export function pushRow(table: Table, cells: MutableColumns, row: Row): void {
  for (const c of TABLE_COLUMNS[table]) cells[c.name]?.push(row[c.name] ?? null);
}

export function batchFromRows(table: Table, rows: readonly Row[]): ColumnBatch {
  const cells = emptyColumns(table);
  for (const row of rows) pushRow(table, cells, row);
  return { length: rows.length, cells };
}

/** `a`'s rows followed by `b`'s, as a new batch. */
export function concatBatches(
  table: Table,
  a: ColumnBatch,
  b: ColumnBatch,
): { length: number; cells: MutableColumns } {
  const cells: MutableColumns = {};
  for (const c of TABLE_COLUMNS[table])
    cells[c.name] = [...(a.cells[c.name] ?? []), ...(b.cells[c.name] ?? [])];
  return { length: a.length + b.length, cells };
}

/** Row `i` of a batch as a row object (every column present). For checks and tests; not for bulk use. */
export function rowAt(table: Table, batch: ColumnBatch, i: number): Row {
  const row: Row = {};
  for (const c of TABLE_COLUMNS[table]) row[c.name] = batch.cells[c.name]?.[i] ?? null;
  return row;
}
