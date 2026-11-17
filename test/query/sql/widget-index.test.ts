import '../../../src/writer/parquet-wasm-source.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { batchFromRows } from '../../../src/format/parquet/batch.js';
import { encodeColumns } from '../../../src/format/parquet/codec.js';
import { widgetTracesColumns } from '../../../src/format/parquet/columns.js';
import type { Row } from '../../../src/format/parquet/rows.js';
import { toSql } from '../../../src/query/sql/columns.js';
import type { SqlFilter } from '../../../src/query/sql/filter.js';
import { spanCountQuery, traceRowsQuery, windowTraceRowsQuery } from '../../../src/query/sql/spans.js';
import { type WidgetIndexRoute, widgetIndexRelation } from '../../../src/query/sql/widget-index.js';
import { openTestDb, type TestDb } from '../../../test-support/duckdb-node.js';

const route = (over: Partial<WidgetIndexRoute> = {}): WidgetIndexRoute => ({
  files: ['p1/widget_traces.parquet', "p'2/widget_traces.parquet"],
  condition: 'abcdef0123456789',
  bindings: [],
  ...over,
});

const filter = (over: Partial<SqlFilter> = {}): SqlFilter => ({
  predicate: null,
  text: null,
  files: { files: ['a/spans.parquet'], all: false, total: 2 },
  window: null,
  epoch: 0n,
  long: false,
  ...over,
});
const noFiles = { files: [], all: true, total: 0 };
const cell =
  (k: string) =>
  (r: Record<string, unknown>): unknown =>
    r[k];
const sqlOf = (q: { toString(): string }): string => q.toString();
const sort = { column: 'start', dir: 'asc' } as const;

describe('SQL text', () => {
  test('the relation reads the index files inline, filtered by condition and bound keys', () => {
    const s = toSql(widgetIndexRelation(route({ bindings: [{ key: 'job', value: "it's" }] })));
    expect(s).toContain(
      "read_parquet(['p1/widget_traces.parquet', 'p''2/widget_traces.parquet'], union_by_name = true)",
    );
    expect(s).toContain("condition = 'abcdef0123456789'");
    expect(s).toContain(`"var:job" = 'it''s'`);
  });
  test('without a route the statements are the ones main builds', () => {
    for (const f of [filter(), filter({ files: { files: ['a/spans.parquet'], all: true, total: 1 } })]) {
      const m = sqlOf(traceRowsQuery(f, sort, 10));
      expect(sqlOf(traceRowsQuery(f, sort, 10, undefined, null))).toBe(m);
      expect(m).toContain('trace_id IN (SELECT DISTINCT "trace_id" FROM "spans"');
      expect(sqlOf(spanCountQuery(f, 'traces'))).toBe(sqlOf(spanCountQuery(f, 'traces', null)));
      expect(sqlOf(spanCountQuery(f, 'traces'))).toBe(
        `SELECT count(DISTINCT trace_id) AS "total" FROM "spans"${f.files.all ? '' : ` WHERE ("filename" IN ('a/spans.parquet'))`}`,
      );
    }
    const w = filter({ window: { start: 1n, end: 2n }, long: true });
    expect(sqlOf(windowTraceRowsQuery(w, noFiles, sort, 5))).toBe(
      sqlOf(windowTraceRowsQuery(w, noFiles, sort, 5, null)),
    );
  });
  test('with a route the matching relation unions the scan and the index', () => {
    const s = sqlOf(traceRowsQuery(filter(), sort, 10, undefined, route()));
    expect(s).toContain('UNION');
    expect(s).toContain(`"filename" IN ('a/spans.parquet')`);
    expect(s).toContain('widget_traces.parquet');
    expect(
      sqlOf(
        windowTraceRowsQuery(
          filter({ window: { start: 1n, end: 2n }, long: true }),
          noFiles,
          sort,
          5,
          route(),
        ),
      ),
    ).toContain('UNION');
    expect(sqlOf(spanCountQuery(filter(), 'traces', route()))).toContain('count(DISTINCT trace_id)');
  });
  test('an empty scan leaves only the index', () => {
    const f = filter({ files: { files: [], all: false, total: 3 } });
    const s = sqlOf(traceRowsQuery(f, sort, 10, undefined, route()));
    expect(s).not.toContain('UNION');
    expect(s).not.toContain('FROM spans');
    expect(s).toContain('widget_traces.parquet');
    const c = sqlOf(spanCountQuery(f, 'traces', route()));
    expect(c).not.toContain('FROM spans');
    expect(c).toContain('count(DISTINCT trace_id)');
  });
});

describe('in DuckDB', () => {
  let db: TestDb;
  const write = (name: string, vars: string[], rows: Row[]): void =>
    db.registerFile(
      name,
      encodeColumns('widget_traces', batchFromRows('widget_traces', rows, widgetTracesColumns(vars)), {
        rowGroupRows: 1024,
        columns: widgetTracesColumns(vars),
      }),
    );
  beforeAll(async () => {
    db = await openTestDb();
    write(
      'i1.parquet',
      ['job'],
      [
        { condition: 'c1', trace_id: 't1', 'var:job': 'a' },
        { condition: 'c1', trace_id: 't1', 'var:job': 'b' },
        { condition: 'c1', trace_id: 't2', 'var:job': 'b' },
        { condition: 'c2', trace_id: 't9', 'var:job': 'a' },
      ],
    );
    write(
      'i2.parquet',
      ['job', 'os'],
      [
        { condition: 'c1', trace_id: 't1', 'var:job': 'a', 'var:os': 'linux' },
        { condition: 'c1', trace_id: 't3', 'var:job': 'a', 'var:os': 'mac' },
      ],
    );
    db.exec(`CREATE TABLE spans AS SELECT * FROM (VALUES ('t3'), ('t4')) v(trace_id)`);
  });
  afterAll(() => db.close());
  const ids = (q: { toString(): string }): string[] =>
    db
      .rows(q.toString())
      .map((r) => String(cell('trace_id')(r)))
      .sort();
  const rt = (over: Partial<WidgetIndexRoute>): WidgetIndexRoute => ({
    files: ['i1.parquet', 'i2.parquet'],
    condition: 'c1',
    bindings: [],
    ...over,
  });

  test('the relation returns the bound traces; unbound columns do not matter', () => {
    expect(ids(widgetIndexRelation(rt({})))).toEqual(['t1', 't1', 't1', 't2', 't3']);
    expect(ids(widgetIndexRelation(rt({ bindings: [{ key: 'job', value: 'b' }] })))).toEqual(['t1', 't2']);
    expect(ids(widgetIndexRelation(rt({ bindings: [{ key: 'job', value: 'a' }] })))).toEqual([
      't1',
      't1',
      't3',
    ]);
    expect(ids(widgetIndexRelation(rt({ files: ['i1.parquet'], condition: 'c2' })))).toEqual(['t9']);
  });
  test('an index-only count of two rows of one trace is 1', () => {
    const f = filter({ files: { files: [], all: false, total: 1 } });
    const total = (r: WidgetIndexRoute): unknown =>
      db.rows(sqlOf(spanCountQuery(f, 'traces', r))).map(cell('total'))[0];
    expect(total(rt({ files: ['i1.parquet'], bindings: [] }))).toBe(2n); // t1 twice (two job values), t2
    expect(total(rt({ files: ['i1.parquet', 'i2.parquet'] }))).toBe(3n); // t1 in two partitions as well
  });
  test('the scan arm and the index arm are deduplicated together', () => {
    const f = filter({ files: { files: ['x'], all: true, total: 1 } });
    expect(db.rows(sqlOf(spanCountQuery(f, 'traces', rt({})))).map(cell('total'))[0]).toBe(4n); // t1 t2 t3 t4
  });
});
