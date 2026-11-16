import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { RowCursor } from '../../src/query/sql/cursor.js';
import { buildFilter } from '../../src/query/sql/filter.js';
import { logRowsQuery } from '../../src/query/sql/logs.js';
import { allTraceRowsQuery, spanRowsQuery } from '../../src/query/sql/spans.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { logRows } from '../../src/viewer/data/log-results.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import type { LogQuery, SpanQuery, SpanRow, TraceRow } from '../../src/viewer/data/results.js';
import { spanRows, traceRows } from '../../src/viewer/data/span-results.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../test-support/format4-fixture.js';
import {
  attr,
  type JsonObject,
  logRecord,
  logsRequest,
  span,
  traceRequest,
} from '../../test-support/otlp-builders.js';
import { EPOCH_NS, otlp } from '../../test-support/writer-deps.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
const BASE = BigInt(EPOCH_NS);
const ns = (ms: number): bigint => BigInt(Math.round(ms * 1e6));
const str = (v: string): JsonObject => ({ stringValue: v });

interface S {
  trace: number;
  id: number;
  name: string;
  startMs: number;
  durMs?: number;
}

function spansRequest(spans: S[]) {
  const mine = spans.map((s) =>
    span({
      traceId: hex(s.trace, 32),
      spanId: hex(s.id, 16),
      name: s.name,
      startTimeUnixNano: String(BASE + ns(s.startMs)),
      endTimeUnixNano: String(BASE + ns(s.startMs) + ns(s.durMs ?? 10)),
    }),
  );
  return otlp(traceRequest(mine, [attr('service.name', str('svc'))]) as never);
}

let nextId = 1;
/** Five spans of their own traces in a partition starting at `at` ms (100 ms apart). */
const own = (at: number, name: string, count = 5): S[] =>
  Array.from({ length: count }, (_, j) => {
    const id = nextId++;
    return { trace: id, id, name: `${name}-${j}`, startMs: at + j * 100 };
  });

// P0..P3 are 1000 ms apart; P2 has two spans at one instant (a tie inside a file), P4 and P5 hold two traces that cross
// them (the older part of 99 and 98 starts just before P5 and ends inside it), P6 arrives late and overlaps P0 to P2.
const P0 = own(0, 'commit'); // `commit` is found only in the oldest partition
const P1 = own(1000, 'work');
const P2: S[] = [...own(2000, 'work'), { trace: 700, id: 700, name: 'work-tie', startMs: 2200 }];
const P3 = own(3000, 'work');
const P4: S[] = [
  ...own(4000, 'work', 3),
  { trace: 99, id: 9901, name: 'cross-a', startMs: 4990, durMs: 100 },
  { trace: 98, id: 9801, name: 'cross-b', startMs: 4980, durMs: 100 },
];
const P5: S[] = [
  ...own(5000, 'work', 3),
  { trace: 99, id: 9902, name: 'cross-a2', startMs: 5200 },
  { trace: 98, id: 9802, name: 'cross-b2', startMs: 5250 },
];
const P6: S[] = [
  { trace: 701, id: 701, name: 'late-0', startMs: 500 },
  { trace: 702, id: 702, name: 'late-1', startMs: 2200 }, // ties with a span of P2
  { trace: 703, id: 703, name: 'late-2', startMs: 1500 },
];

/** Logs of a partition: `count` records `10` ms apart from `at`, two sharing one instant. */
function logsPartition(at: number, name: string, count = 5) {
  const records = Array.from({ length: count + 1 }, (_, j) =>
    logRecord({
      timeUnixNano: String(BASE + ns(at + Math.min(j, count - 1) * 10)),
      observedTimeUnixNano: String(BASE + ns(at + Math.min(j, count - 1) * 10)),
      body: str(`${name}-${j}`),
      attributes: [attr('id', str(`${name}-${j}`))],
    }),
  );
  return otlp(logsRequest(records, [attr('service.name', str('svc'))]) as never);
}

let f: Format4Fixture;
let db: TestDb;
const sources: DataSource[] = [];

/** A data source over its own coordinator (it caches by statement text) that records what each statement prepared. */
function recording() {
  const inner = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
  const statements: { sql: string; prepared: readonly string[] }[] = [];
  let prepared: readonly string[] = [];
  const engine: QueryEngine = {
    ...inner,
    prepare: async (paths, signal) => {
      prepared = paths;
      await inner.prepare(paths, signal);
    },
    query: (q, signal) => {
      const text = String(q);
      // the files a statement reads: its own list, else every file of the shared view (prepared races with siblings)
      const listed = [...text.matchAll(/'([^']+\.parquet)'/g)].map((m) => m[1] as string);
      statements.push({ sql: text, prepared: listed.length > 0 ? listed : prepared });
      return inner.query(q, signal);
    },
  };
  const source = createDuckDbDataSource({ engine, manifest: f.manifest });
  sources.push(source);
  return { source, statements, engine: inner };
}

beforeAll(async () => {
  nextId = 1;
  f = await buildFormat4Report(
    [
      spansRequest(P0),
      spansRequest(P1),
      spansRequest(P2),
      spansRequest(P3),
      spansRequest(P4),
      spansRequest(P5),
      spansRequest(P6),
      logsPartition(0, 'l0'),
      logsPartition(1000, 'l1'),
      logsPartition(2000, 'l2'),
      logsPartition(3000, 'l3'),
      logsPartition(4000, 'l4'),
    ],
    { close: false },
  );
  db = await openFixtureDb(f);
});
afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
});

const spanQuery = (over: Partial<SpanQuery> = {}): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 4,
  groupBy: null,
  measureBy: null,
  needs: ['rows'],
  facetKeys: null,
  ...over,
});
const logQuery = (over: Partial<LogQuery> = {}): LogQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'logs',
  sort: { column: 'time', dir: 'asc' },
  limit: 4,
  needs: ['rows'],
  facetKeys: null,
  ...over,
});

/** What identifies a span row whatever page interned it (the resource and scope refs differ per page). */
const spanKey = (r: SpanRow): string => `${r.span.traceId}/${r.span.spanId}/${r.span.start}`;

/** `main`'s answer: one statement over every file of the shared view, `limit` 10,000, no cursor. */
async function mainSpans(over: Partial<SpanQuery> = {}) {
  const q = spanQuery(over);
  const { filter } = buildFilter({
    manifest: f.manifest,
    table: 'spans',
    condition: q.condition,
    text: q.text,
    window: null,
  });
  const engine = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
  const t = await engine.query(spanRowsQuery(filter, q.sort as never, 10_000));
  return spanRows(t, BigInt(f.manifest.epochUnixNano)).rows;
}

describe('paging the lists to the end returns main`s answer', () => {
  for (const dir of ['asc', 'desc'] as const) {
    test(`spans, ${dir}: every page in order, once, and the total`, async () => {
      const { source } = recording();
      const main = await mainSpans({ sort: { column: 'start', dir } });
      const got: SpanRow[] = [];
      let cursor: RowCursor | null = null;
      let pages = 0;
      for (;;) {
        const r = await source.querySpans(
          spanQuery({ sort: { column: 'start', dir }, cursor, needs: ['rows'] }),
        );
        expect(r.total).toBe(main.length);
        expect(r.rows.length).toBeLessThanOrEqual(4);
        got.push(...(r.rows as SpanRow[]));
        pages++;
        if (r.next == null) break;
        expect(r.rows).toHaveLength(4);
        cursor = r.next;
      }
      expect(pages).toBeGreaterThan(3);
      expect(got.map(spanKey)).toEqual(main.map(spanKey));
    });

    test(`logs, ${dir}: every page in order, once, and the total`, async () => {
      const { source, engine } = recording();
      const q = logQuery({ sort: { column: 'time', dir } });
      const { filter } = buildFilter({
        manifest: f.manifest,
        table: 'logs',
        condition: null,
        text: '',
        window: null,
      });
      const main = logRows(await engine.query(logRowsQuery(filter, q.sort as never, 10_000))).rows;
      const got: string[] = [];
      let cursor: RowCursor | null = null;
      for (;;) {
        const r = await source.queryLogs({ ...q, cursor });
        expect(r.total).toBe(main.length);
        got.push(...(r.rows as unknown as { ref: string }[]).map((x) => x.ref));
        if (r.next == null) break;
        cursor = r.next;
      }
      expect(got).toEqual(main.map((x) => x.ref));
    });

    test(`traces, ${dir}: every page in order, once, and the total`, async () => {
      const { source, engine } = recording();
      const sort = { column: 'start', dir } as const;
      const { filter } = buildFilter({
        manifest: f.manifest,
        table: 'spans',
        condition: null,
        text: '',
        window: null,
      });
      const mainTable = await engine.query(allTraceRowsQuery(filter, sort, 10_000));
      const main = traceRows(mainTable);
      const got: TraceRow[] = [];
      let cursor: RowCursor | null = null;
      for (;;) {
        const r = await source.querySpans(spanQuery({ mode: 'traces', sort, cursor }));
        expect(r.total).toBe(main.total);
        got.push(...(r.rows as TraceRow[]));
        if (r.next == null) break;
        cursor = r.next;
      }
      expect(got).toEqual(main.rows);
    });
  }

  test('a condition that matches only the oldest partition: the cutoff extends until the page fills', async () => {
    const { source, statements } = recording();
    const main = await mainSpans({ sort: { column: 'start', dir: 'desc' }, text: 'commit' });
    expect(main).toHaveLength(5);
    // a cursor after every span: a next page, which reads the newest files that can hold rows after it
    const cursor: RowCursor = { time: BASE + ns(9000), filename: '', row: 0n, spanId: '' };
    const r = await source.querySpans(
      spanQuery({ sort: { column: 'start', dir: 'desc' }, text: 'commit', limit: 3, cursor }),
    );
    expect((r.rows as SpanRow[]).map(spanKey)).toEqual(main.slice(0, 3).map(spanKey));
    expect(r.next).not.toBeNull();
    // several statements for the rows: the newest files found nothing, the page was read again over older ones
    const rowsStatements = statements.filter((s) => s.sql.includes('LIMIT 4'));
    expect(rowsStatements.length).toBeGreaterThan(1);
    expect(rowsStatements.at(-1)?.prepared.length).toBeGreaterThan(rowsStatements[0]?.prepared.length ?? 0);
  });

  test('a residual condition returns main`s rows and totals, with no next page', async () => {
    const { source } = recording();
    const condition = 'Len(name) > 7';
    const all = await source.querySpans(
      spanQuery({ condition, limit: 10_000, sort: { column: 'start', dir: 'asc' }, needs: ['rows'] }),
    );
    const names = (all.rows as SpanRow[]).map((r) => r.span.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.length > 7)).toBe(true);
    const some = await source.querySpans(spanQuery({ condition, limit: 3, needs: ['rows'] }));
    expect((some.rows as SpanRow[]).map(spanKey)).toEqual((all.rows as SpanRow[]).slice(0, 3).map(spanKey));
    // as on `main`: the scan stopped early, so the total is the candidate count (every span), an upper bound
    expect(all.total).toBe(names.length);
    expect(some.total).toBe(34);
    expect(some.next ?? null).toBeNull();
  });
});

describe('a first page reads only the files the cutoff keeps', () => {
  const rowsStatement = (statements: { sql: string; prepared: readonly string[] }[]) =>
    statements.filter((s) => /LIMIT \d+$/.test(s.sql) && s.sql.includes('ORDER BY'));
  const spansPaths = (): string[] =>
    f.manifest.partitions.flatMap((p) => (p.files.spans === undefined ? [] : [p.files.spans.path]));

  const AFTER_ALL: RowCursor = { time: BASE + ns(9000), filename: '', row: 0n, spanId: '' };

  test('descending spans, a next page: the newest partitions only, in newest-first order', async () => {
    const { source, statements } = recording();
    const r = await source.querySpans(
      spanQuery({ sort: { column: 'start', dir: 'desc' }, limit: 2, cursor: AFTER_ALL }),
    );
    expect(r.rows).toHaveLength(2);
    const [page] = rowsStatement(statements);
    expect(page).toBeDefined();
    const prepared = page?.prepared ?? [];
    expect(prepared.length).toBeLessThan(spansPaths().length);
    expect(prepared.length).toBeGreaterThan(0);
    // the statement lists its files itself, newest partition first
    expect(page?.sql).toContain('read_parquet([');
    const order = spansPaths().filter((p) => prepared.includes(p));
    const at = (p: string): number => page?.sql.indexOf(`'${p}'`) ?? -1;
    for (let i = 1; i < order.length; i++)
      expect(at(order[i] as string)).toBeLessThan(at(order[i - 1] as string));
  });

  test('a first page whose total or facets read the raw files reads the same files as main', async () => {
    for (const needs of [['rows'], ['rows', 'facets']] as const) {
      const { source, statements } = recording();
      await source.querySpans(
        spanQuery({ sort: { column: 'start', dir: 'desc' }, limit: 2, needs: [...needs] }),
      );
      const [page] = rowsStatement(statements);
      // the shared view, every file: no list of its own and no `filename IN (...)`, as on main
      expect(page?.sql).not.toContain('read_parquet');
      expect(page?.sql).not.toMatch(/"?filename"? IN/);
    }
  });

  test('ascending logs, a next page: the oldest partitions only', async () => {
    const { source, statements } = recording();
    const first = await source.queryLogs(logQuery({ limit: 3 }));
    expect(first.next).not.toBeNull();
    statements.length = 0;
    const r = await source.queryLogs(logQuery({ limit: 3, cursor: first.next ?? null }));
    expect(r.rows).toHaveLength(3);
    const [page] = rowsStatement(statements);
    const logsPaths = f.manifest.partitions.flatMap((p) =>
      p.files.logs === undefined ? [] : [p.files.logs.path],
    );
    expect(page?.prepared.length).toBeLessThan(logsPaths.length);
  });

  test('a non-time sort keeps the single statement over the shared view', async () => {
    const { source, statements } = recording();
    await source.querySpans(spanQuery({ sort: { column: 'duration', dir: 'desc' }, limit: 3 }));
    const [page] = rowsStatement(statements);
    expect(page?.sql).not.toContain('read_parquet');
    expect(page?.sql).toContain('LIMIT 3');
  });

  test('a trace that crosses two partitions is whole on the first page', async () => {
    const { source, engine } = recording();
    const sort = { column: 'start', dir: 'desc' } as const;
    // pages of 3: P5 holds 3 own traces, the page is those and trace 99, whose older part is in P4
    const first = await source.querySpans(spanQuery({ mode: 'traces', sort, limit: 4 }));
    const { filter } = buildFilter({
      manifest: f.manifest,
      table: 'spans',
      condition: null,
      text: '',
      window: null,
    });
    const main = traceRows(await engine.query(allTraceRowsQuery(filter, sort, 10_000))).rows;
    expect(first.rows).toEqual(main.slice(0, 4));
    const cross = (first.rows as TraceRow[]).find((r) => r.spans === 2);
    expect(cross).toBeDefined();
    expect(first.next).not.toBeNull();
    // the next page never moves what is on screen
    const second = await source.querySpans(
      spanQuery({ mode: 'traces', sort, limit: 4, cursor: first.next ?? null }),
    );
    expect(second.rows).toEqual(main.slice(4, 8));
  });
});
