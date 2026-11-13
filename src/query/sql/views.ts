import type { ManifestV4 } from '../../format/manifest.js';
import {
  type ColumnType,
  ROLLUP_OF,
  type RollupTable,
  TABLE_COLUMNS,
  TABLES,
  type Table,
} from '../../format/parquet/columns.js';
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

/** The two rollup tables, whose views are created when a statement needs them (`rollupViewStatements`). */
const ROLLUP_TABLES: readonly RollupTable[] = Object.keys(ROLLUP_OF) as RollupTable[];
const isRollup = (table: Table): table is RollupTable => table in ROLLUP_OF;

type Head = 'CREATE OR REPLACE VIEW' | 'CREATE VIEW IF NOT EXISTS';

function viewStatement(
  manifest: ManifestV4,
  table: Table,
  resolve: (path: string) => string,
  head: Head,
): string {
  const files = tableFiles(manifest, table, resolve);
  if (files.length === 0) {
    const columns = [
      ...TABLE_COLUMNS[table].map((c) => `NULL::${duckdbType(c.type)} AS ${quoteIdent(c.name)}`),
      'NULL::BIGINT AS file_row_number',
      'NULL::VARCHAR AS filename',
    ];
    return `${head} ${quoteIdent(table)} AS SELECT ${columns.join(', ')} WHERE false`;
  }
  const list = files.map(quoteString).join(', ');
  return `${head} ${quoteIdent(table)} AS SELECT * FROM read_parquet([${list}], filename = true, file_row_number = true, union_by_name = false)`;
}

/**
 * One `CREATE OR REPLACE VIEW <table> AS SELECT * FROM read_parquet([...], filename = true, file_row_number = true,
 * union_by_name = false)` per table; a table with no file gets a typed empty view (`SELECT NULL::<type> AS <col>, ...,
 * NULL::BIGINT AS file_row_number, NULL::VARCHAR AS filename WHERE false`: the same columns in the same order as a
 * populated view, whose virtual columns end `file_row_number, filename`). `set` picks the tables: `'all'` (the default,
 * what a host creates), `'base'` (the five tables every page reads, created when a report opens) or `'rollups'`.
 */
export function viewStatements(
  manifest: ManifestV4,
  resolve: (path: string) => string,
  set: 'all' | 'base' | 'rollups' = 'all',
): string[] {
  return TABLES.filter((t) => set === 'all' || isRollup(t) === (set === 'rollups')).map((table) =>
    viewStatement(manifest, table, resolve, 'CREATE OR REPLACE VIEW'),
  );
}

/**
 * The views of the rollup tables, created by the data source on the first statement that reads a rollup file (binding
 * a view reads each file's footer, which a page that never routes to the rollups should not pay). `CREATE VIEW IF NOT
 * EXISTS`: a view that exists (a host's, or one made for this manifest earlier) is kept; with `replace` (the source made by a
 * Refresh) it is bound again, whatever an earlier source left.
 */
export function rollupViewStatements(
  manifest: ManifestV4,
  resolve: (path: string) => string,
  replace = false,
): string[] {
  return ROLLUP_TABLES.map((table) =>
    viewStatement(manifest, table, resolve, replace ? 'CREATE OR REPLACE VIEW' : 'CREATE VIEW IF NOT EXISTS'),
  );
}

/** `DROP VIEW IF EXISTS` for each rollup table: a Refresh forgets the views so the next statement that needs them binds the new file list. */
export function dropRollupViewStatements(): string[] {
  return ROLLUP_TABLES.map((table) => `DROP VIEW IF EXISTS ${quoteIdent(table)}`);
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
