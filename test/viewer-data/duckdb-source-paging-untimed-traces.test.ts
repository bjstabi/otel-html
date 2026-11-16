import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { RowCursor } from '../../src/query/sql/cursor.js';
import { buildFilter } from '../../src/query/sql/filter.js';
import { allTraceRowsQuery } from '../../src/query/sql/spans.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { SpanQuery, TraceRow } from '../../src/viewer/data/results.js';
import { traceRows } from '../../src/viewer/data/span-results.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../test-support/format4-fixture.js';
import { attr, span, traceRequest } from '../../test-support/otlp-builders.js';
import { EPOCH_NS, otlp } from '../../test-support/writer-deps.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const BASE = BigInt(EPOCH_NS);
const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
/** Traces with an id from here have no start time (the writer never writes one; the view below blanks it). */
const FIRST_UNTIMED = 100;

let f: Format4Fixture;
let db: TestDb;
const sources: DataSource[] = [];

function partition(traces: number[]) {
  const spans = traces.map((t) =>
    span({
      traceId: hex(t, 32),
      spanId: hex(t, 16),
      name: `t${t}`,
      startTimeUnixNano: String(BASE + BigInt(t)),
      endTimeUnixNano: String(BASE + BigInt(t) + 1n),
    }),
  );
  return otlp(traceRequest(spans, [attr('service.name', { stringValue: 'svc' })]) as never);
}

beforeAll(async () => {
  // more untimed traces than a page, in both files
  f = await buildFormat4Report(
    [partition([10, 20, 30, 101, 105, 103, 107]), partition([40, 50, 102, 106, 104, 108])],
    { close: false },
  );
  db = await openFixtureDb(f);
  // a trace without a timed span: its rows carry no start or end time
  db.exec('ALTER VIEW traces RENAME TO traces_raw');
  const blank = (c: string): string =>
    `CASE WHEN trace_id >= '${hex(FIRST_UNTIMED, 32)}' THEN NULL ELSE ${c} END AS ${c}`;
  db.exec(
    `CREATE VIEW traces AS SELECT * REPLACE (${blank('start_time_unix_nano')}, ${blank('end_time_unix_nano')}) FROM traces_raw`,
  );
});
afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
});

const query = (over: Partial<SpanQuery>): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'traces',
  sort: { column: 'start', dir: 'desc' },
  limit: 3,
  groupBy: null,
  measureBy: null,
  needs: ['rows'],
  facetKeys: null,
  ...over,
});

describe('trace lists with more untimed traces than a page', () => {
  for (const dir of ['asc', 'desc'] as const) {
    test(`${dir}: paged to the end equals main's single statement`, async () => {
      const engine = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
      const source = createDuckDbDataSource({ engine, manifest: f.manifest });
      sources.push(source);
      const sort = { column: 'start', dir } as const;
      const { filter } = buildFilter({
        manifest: f.manifest,
        table: 'spans',
        condition: null,
        text: '',
        window: null,
      });
      const main = traceRows(await engine.query(allTraceRowsQuery(filter, sort, 10_000)));
      expect(main.rows).toHaveLength(13);
      const got: TraceRow[] = [];
      let cursor: RowCursor | null = null;
      for (;;) {
        const r = await source.querySpans(query({ sort, cursor }));
        if (cursor === null) expect(r.total).toBe(13);
        got.push(...(r.rows as TraceRow[]));
        if (r.next == null) break;
        cursor = r.next;
      }
      expect(got.map((t) => t.traceId)).toEqual(main.rows.map((t) => t.traceId));
      expect(got).toEqual(main.rows);
    });
  }
});
