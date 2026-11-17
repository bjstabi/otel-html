import { type ColumnDef, TABLE_COLUMNS, type Table } from './columns.js';
import type { Row } from './rows.js';

/**
 * Rows of one table as one array per column (`null` for a missing cell), in `TABLE_COLUMNS[table]` order. Holding
 * columns instead of row objects keeps the writer's memory small: a row object per record is promoted garbage.
 */
export interface ColumnBatch {
  readonly length: number;
  readonly cells: Readonly<Record<string, readonly unknown[]>>;
}

export type MutableColumns = Record<string, unknown[]>;

/** A `ColumnBatch` whose arrays a writer still appends to. */
export interface MutableBatch {
  length: number;
  cells: MutableColumns;
}

export function emptyColumns(
  table: Table,
  columns: readonly ColumnDef[] = TABLE_COLUMNS[table],
): MutableColumns {
  const cells: MutableColumns = {};
  for (const c of columns) cells[c.name] = [];
  return cells;
}

/** Copies one row's cells onto the column arrays (a column the row lacks gets `null`; unknown keys are ignored). */
export function pushRow(
  table: Table,
  cells: MutableColumns,
  row: Row,
  columns: readonly ColumnDef[] = TABLE_COLUMNS[table],
): void {
  for (const c of columns) cells[c.name]?.push(row[c.name] ?? null);
}

export function batchFromRows(
  table: Table,
  rows: readonly Row[],
  columns: readonly ColumnDef[] = TABLE_COLUMNS[table],
): ColumnBatch {
  const cells = emptyColumns(table, columns);
  for (const row of rows) pushRow(table, cells, row, columns);
  return { length: rows.length, cells };
}

/** `a`'s rows followed by `b`'s, as a new batch. */
export function concatBatches(table: Table, a: ColumnBatch, b: ColumnBatch): MutableBatch {
  const cells: MutableColumns = {};
  for (const c of TABLE_COLUMNS[table])
    cells[c.name] = [...(a.cells[c.name] ?? []), ...(b.cells[c.name] ?? [])];
  return { length: a.length + b.length, cells };
}
