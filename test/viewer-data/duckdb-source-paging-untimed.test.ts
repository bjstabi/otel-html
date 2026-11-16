import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { RowCursor } from '../../src/query/sql/cursor.js';
import { buildFilter } from '../../src/query/sql/filter.js';
import { logRowsQuery } from '../../src/query/sql/logs.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { logRows } from '../../src/viewer/data/log-results.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { LogQuery } from '../../src/viewer/data/results.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../test-support/format4-fixture.js';
import { attr, logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import { EPOCH_NS, otlp } from '../../test-support/writer-deps.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const BASE = BigInt(EPOCH_NS);
const ns = (ms: number): bigint => BigInt(Math.round(ms * 1e6));

/** Five timed logs from `at` ms, 10 ms apart, and `untimed` logs that carry neither a time nor an observed time. */
function partition(at: number, name: string, untimed = 0) {
  const timed = Array.from({ length: 5 }, (_, j) =>
    logRecord({
      timeUnixNano: String(BASE + ns(at + j * 10)),
      observedTimeUnixNano: String(BASE + ns(at + j * 10)),
      body: { stringValue: `${name}-${j}` },
    }),
  );
  const none = Array.from({ length: untimed }, (_, j) => {
    const {
      timeUnixNano: _t,
      observedTimeUnixNano: _o,
      ...rest
    } = logRecord({
      body: { stringValue: `${name}-none-${j}` },
    });
    return rest;
  });
  return otlp(logsRequest([...timed, ...none], [attr('service.name', { stringValue: 'svc' })]) as never);
}

let f: Format4Fixture;
let db: TestDb;
const sources: DataSource[] = [];

beforeAll(async () => {
  // the untimed logs sit in the oldest file and in the newest, so neither end of the list is theirs by their file's times
  f = await buildFormat4Report(
    [partition(1000, 'p0', 2), partition(2000, 'p1'), partition(3000, 'p2'), partition(4000, 'p3', 1)],
    { close: false },
  );
  db = await openFixtureDb(f);
});
afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
});

const logQuery = (over: Partial<LogQuery>): LogQuery => ({
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

describe('logs without a time or an observed time page like main', () => {
  for (const dir of ['asc', 'desc'] as const) {
    test(`${dir}: every log once, in main's order, the untimed ones where the epoch puts them`, async () => {
      const engine = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
      const source = createDuckDbDataSource({ engine, manifest: f.manifest });
      sources.push(source);
      const sort = { column: 'time', dir } as const;
      const { filter } = buildFilter({
        manifest: f.manifest,
        table: 'logs',
        condition: null,
        text: '',
        window: null,
      });
      const main = logRows(await engine.query(logRowsQuery(filter, sort, 10_000))).rows;
      expect(main).toHaveLength(23);
      const got: string[] = [];
      let cursor: RowCursor | null = null;
      for (;;) {
        const r = await source.queryLogs(logQuery({ sort, cursor }));
        if (cursor === null) expect(r.total).toBe(23);
        got.push(...(r.rows as unknown as { ref: string }[]).map((x) => x.ref));
        if (r.next == null) break;
        cursor = r.next;
      }
      expect(got).toEqual(main.map((x) => x.ref));
    });
  }
});
