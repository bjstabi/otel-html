import { describe, expect, test } from 'vitest';
import { TABLE_COLUMNS, TABLES } from '../../../src/format/parquet/columns.js';
import {
  dropRollupViewStatements,
  duckdbType,
  partitionOfFilename,
  rollupViewStatements,
  tableFiles,
  viewStatements,
} from '../../../src/query/sql/views.js';
import { openTestDb } from '../../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  emptyManifest,
  openFixtureDb,
  spansOnlyRequest,
} from '../../../test-support/format4-fixture.js';

type Row = Record<string, unknown>;
const column = (rows: Row[], name: string): unknown[] => rows.map((r) => r[name]);
const first = (rows: Row[], name: string): unknown => rows[0]?.[name];

describe('format-4 views', () => {
  test('every table is a view; a table with no file is typed and empty', async () => {
    const f = await buildFormat4Report([spansOnlyRequest(3)]); // spans and traces only
    const db = await openFixtureDb(f);
    expect(first(db.rows('SELECT count(*) AS n FROM spans'), 'n')).toBe(3n);
    expect(first(db.rows('SELECT count(*) AS n FROM logs'), 'n')).toBe(0n);
    expect(db.rows('SELECT typeof(severity_number) AS t FROM logs LIMIT 1')).toEqual([]);
    expect(column(db.rows('DESCRIBE logs'), 'column_name')).toEqual([
      ...TABLE_COLUMNS.logs.map((c) => c.name),
      'file_row_number',
      'filename',
    ]);
  });
  test('filename and file_row_number name the partition and the row', async () => {
    const f = await buildFormat4Report([spansOnlyRequest(2), spansOnlyRequest(2)], { close: false });
    const db = await openFixtureDb(f);
    const rows = db.rows('SELECT filename, file_row_number AS i FROM spans ORDER BY filename, i');
    expect(column(rows, 'filename').map((v) => partitionOfFilename(String(v)))).toEqual([0, 0, 1, 1]);
    expect(column(rows, 'i')).toEqual([0n, 1n, 0n, 1n]);
  });
  test('a filename predicate reads the named files only', async () => {
    const f = await buildFormat4Report([spansOnlyRequest(2), spansOnlyRequest(5)], { close: false });
    const db = await openFixtureDb(f);
    const [only] = tableFiles(f.manifest, 'spans', (p) => p).slice(1);
    expect(first(db.rows(`SELECT count(*) AS n FROM spans WHERE filename = '${only}'`), 'n')).toBe(5n);
  });
  test('rollup paths are partition files', () => {
    expect(partitionOfFilename('https://x/data/partitions/000012/log_rollups.parquet')).toBe(12);
    expect(partitionOfFilename('data/partitions/000012/span_rollups.parquet')).toBe(12);
  });
  test('viewStatements of an empty manifest creates seven empty views', async () => {
    const stmts = viewStatements(emptyManifest(), (p) => p);
    expect(stmts).toHaveLength(7);
    for (const s of stmts) expect(s).toMatch(/WHERE false$/);
    const db = await openTestDb();
    for (const s of stmts) db.exec(s);
    for (const table of TABLES) {
      expect(first(db.rows(`SELECT count(*) AS n FROM ${table}`), 'n')).toBe(0n);
    }
    db.close();
  });
  test('the base views and the rollup views are separate sets; the rollup views are created only when missing', async () => {
    const f = await buildFormat4Report([spansOnlyRequest(3)]);
    const base = viewStatements(f.manifest, (p) => p, 'base');
    const rollups = viewStatements(f.manifest, (p) => p, 'rollups');
    expect(base).toHaveLength(5);
    expect(rollups).toHaveLength(2);
    expect([...base, ...rollups].sort()).toEqual(viewStatements(f.manifest, (p) => p).sort());
    for (const s of base) expect(s).not.toContain('_rollups');
    const lazy = rollupViewStatements(f.manifest, (p) => p);
    expect(lazy).toHaveLength(2);
    for (const s of lazy) expect(s).toMatch(/^CREATE VIEW IF NOT EXISTS "(span|log)_rollups" AS /);
    expect(dropRollupViewStatements()).toEqual([
      'DROP VIEW IF EXISTS "span_rollups"',
      'DROP VIEW IF EXISTS "log_rollups"',
    ]);
    // a view that exists is kept, a dropped one is bound again with the new file list
    const db = await openFixtureDb(f);
    const before = first(db.rows('SELECT count(*) AS n FROM span_rollups'), 'n');
    for (const s of lazy) db.exec(s);
    expect(first(db.rows('SELECT count(*) AS n FROM span_rollups'), 'n')).toBe(before);
    for (const s of dropRollupViewStatements()) db.exec(s);
    for (const s of lazy) db.exec(s);
    expect(first(db.rows('SELECT count(*) AS n FROM span_rollups'), 'n')).toBe(before);
    db.close();
  });
  test('a populated view and the empty view of the same table DESCRIBE alike', async () => {
    const f = await buildFormat4Report([spansOnlyRequest(2)]);
    const populated = await openFixtureDb(f);
    const empty = await openFixtureDb({ ...f, manifest: emptyManifest(), files: new Map() });
    const shape = (db: typeof populated, table: string) =>
      db
        .rows(`DESCRIBE ${table}`)
        .map((r) => [(r as { column_name: string }).column_name, (r as { column_type: string }).column_type]);
    const checked: string[] = [];
    for (const table of TABLES) {
      if (f.manifest.partitions.some((p) => p.files[table] !== undefined)) {
        expect(shape(empty, table)).toEqual(shape(populated, table));
        checked.push(table);
      }
    }
    expect(checked).toEqual(expect.arrayContaining(['spans', 'traces']));
  });
  test('a single quote in a path doubles', () => {
    const m = emptyManifest();
    m.partitions = [
      {
        n: 0,
        source: 's',
        files: { spans: { path: "a'b.parquet", bytes: 1, rows: 1, timeMin: '0', timeMax: '0', values: {} } },
      },
    ];
    expect(viewStatements(m, (p) => p)[0]).toContain("'a''b.parquet'");
  });
  test('duckdbType maps every column type', () => {
    expect(duckdbType('list_int64')).toBe('BIGINT[]');
    expect(duckdbType('json')).toBe('VARCHAR');
  });
  test('partitionOfFilename throws a typed error without a partition', () => {
    expect(() => partitionOfFilename('x.parquet')).toThrowError(/invalid-report|partitions/);
  });
  test('the connector records requests and returns IPC bytes', async () => {
    const f = await buildFormat4Report([spansOnlyRequest(1)]);
    const db = await openFixtureDb(f);
    const bytes = await db.connector.query({ type: 'arrow', sql: 'SELECT 1 AS x' });
    expect(bytes).toBeInstanceOf(Uint8Array);
    await db.connector.query({ type: 'exec', sql: 'SELECT 1' });
    expect(db.connector.requests.map((r) => r.type)).toEqual(['arrow', 'exec']);
  });
});
