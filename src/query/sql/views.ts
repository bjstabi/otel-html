import type { ManifestV4 } from '../../format/manifest.js';
import { type ColumnType, TABLE_COLUMNS, TABLES, type Table } from '../../format/parquet/columns.js';
import { OtelHtmlError } from '../../model/errors.js';

const DUCKDB_TYPES: Record<ColumnType, string> = {
  utf8: 'VARCHAR',
  json: 'VARCHAR',
  int32: 'INTEGER',
  int64: 'BIGINT',
  float64: 'DOUBLE',
  bool: 'BOOLEAN',
  list_float64: 'DOUBLE[]',
  list_int64: 'BIGINT[]',
};

/** DuckDB type of a column: utf8/json VARCHAR, int32 INTEGER, int64 BIGINT, float64 DOUBLE, bool BOOLEAN, lists DOUBLE[] / BIGINT[]. */
export function duckdbType(type: ColumnType): string {
  return DUCKDB_TYPES[type];
}

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const quoteString = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** The files of `table` in manifest order, as the names they are registered under (`resolve(manifestPath)`). */
export function tableFiles(manifest: ManifestV4, table: Table, resolve: (path: string) => string): string[] {
  const out: string[] = [];
  for (const partition of manifest.partitions) {
    const file = partition.files[table];
    if (file !== undefined) out.push(resolve(file.path));
  }
  return out;
}

function viewStatement(manifest: ManifestV4, table: Table, resolve: (path: string) => string): string {
  const files = tableFiles(manifest, table, resolve);
  if (files.length === 0) {
    const columns = [
      ...TABLE_COLUMNS[table].map((c) => `NULL::${duckdbType(c.type)} AS ${quoteIdent(c.name)}`),
      'NULL::BIGINT AS file_row_number',
      'NULL::VARCHAR AS filename',
    ];
    return `CREATE OR REPLACE VIEW ${quoteIdent(table)} AS SELECT ${columns.join(', ')} WHERE false`;
  }
  const list = files.map(quoteString).join(', ');
  return `CREATE OR REPLACE VIEW ${quoteIdent(table)} AS SELECT * FROM read_parquet([${list}], filename = true, file_row_number = true, union_by_name = false)`;
}

/**
 * One `CREATE OR REPLACE VIEW <table> AS SELECT * FROM read_parquet([...], filename = true, file_row_number = true,
 * union_by_name = false)` per table; a table with no file gets a typed empty view (`SELECT NULL::<type> AS <col>, ...,
 * NULL::BIGINT AS file_row_number, NULL::VARCHAR AS filename WHERE false`: the same columns in the same order as a
 * populated view, whose virtual columns end `file_row_number, filename`).
 */
export function viewStatements(manifest: ManifestV4, resolve: (path: string) => string): string[] {
  return TABLES.map((table) => viewStatement(manifest, table, resolve));
}

const PARTITION_IN_FILENAME = /(?:^|\/)partitions\/([0-9]{6,})\/[a-z_]+\.parquet$/;

/** The partition number in a `filename` value (`.../partitions/<p6>/<table>.parquet`); invalid-report when absent. */
export function partitionOfFilename(filename: string): number {
  const m = PARTITION_IN_FILENAME.exec(filename);
  if (m?.[1] === undefined) {
    throw new OtelHtmlError('invalid-report', {
      path: 'filename',
      expected: 'a partitions/<n>/<table>.parquet path',
      actual: filename,
    });
  }
  return Number(m[1]);
}
