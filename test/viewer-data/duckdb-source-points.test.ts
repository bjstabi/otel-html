import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { pagesLogList, pagesSpanList, residualOf } from '../../src/viewer/data/list-paging.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
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
const N = 30;

let f: Format4Fixture;
let db: TestDb;
const sources: DataSource[] = [];

function recording() {
  const inner = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
  const statements: string[] = [];
  const engine: QueryEngine = {
    ...inner,
    query: (q, signal) => {
      statements.push(String(q));
      return inner.query(q, signal);
    },
  };
  const source = createDuckDbDataSource({ engine, manifest: f.manifest });
  sources.push(source);
  return { source, statements };
}

beforeAll(async () => {
  const records = Array.from({ length: N }, (_, i) =>
    logRecord({
      timeUnixNano: String(BASE + BigInt(i) * 1_000_000n),
      severityNumber: i % 2 === 0 ? 9 : 17,
      body: { stringValue: `line ${i} ${'x'.repeat(i % 5)}` },
    }),
  );
  f = await buildFormat4Report(
    [otlp(logsRequest(records, [attr('service.name', { stringValue: 'svc' })]) as never)],
    {
      close: false,
    },
  );
  db = await openFixtureDb(f);
});
afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
});

const points = {
  condition: null,
  text: '',
  window: null,
  sort: { column: 'time', dir: 'desc' } as const,
  limit: 1000,
};

describe('logPoints', () => {
  test('one statement that selects time and severity only, in the list order', async () => {
    const { source, statements } = recording();
    const got = await source.logPoints(points, new AbortController().signal);
    expect(got).toHaveLength(N);
    expect(got.map((p) => p.severity)).toEqual(
      Array.from({ length: N }, (_, i) => ((N - 1 - i) % 2 === 0 ? 9 : 17)),
    );
    expect(got.map((p) => p.time)).toEqual([...got.map((p) => p.time)].sort((a, b) => b - a));
    const own = statements.filter(
      (s) => /FROM "?logs"?/.test(s) && /time_rel/.test(s) && !/count\(\*\)/.test(s),
    );
    expect(own).toHaveLength(1);
    const projection = (own[0] ?? '').split(/\bFROM\b/)[0] ?? '';
    expect(projection).toMatch(/AS "?time_rel"?/);
    expect(projection).toMatch(/severity_number/);
    for (const wide of ['body', 'attributes', 'trace_id', 'span_id', 'resource_attributes', 'scope_name'])
      expect(projection, wide).not.toContain(wide);
  });

  test('a limit and a severity sort bound the statement', async () => {
    const { source } = recording();
    const got = await source.logPoints(
      { ...points, sort: { column: 'severity', dir: 'desc' }, limit: 5 },
      new AbortController().signal,
    );
    expect(got.map((p) => p.severity)).toEqual([17, 17, 17, 17, 17]);
  });

  test('a condition the browser evaluates still plots every match up to the limit', async () => {
    const { source } = recording();
    const got = await source.logPoints(
      { ...points, condition: 'Len(body.string) > 9' },
      new AbortController().signal,
    );
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(N);
  });
});

describe('the paging rule has one owner', () => {
  const q = (over: Partial<LogQuery>): LogQuery => ({
    condition: null,
    text: '',
    window: null,
    mode: 'logs',
    sort: { column: 'time', dir: 'desc' },
    limit: 4,
    needs: ['rows'],
    facetKeys: null,
    ...over,
  });

  test('the data source pages exactly the lists the predicate names (next non-null)', async () => {
    const { source } = recording();
    const signal = new AbortController().signal;
    const cases: { name: string; over: Partial<LogQuery>; pages: boolean }[] = [
      { name: 'time sort', over: {}, pages: true },
      { name: 'severity sort', over: { sort: { column: 'severity', dir: 'desc' } }, pages: false },
      { name: 'residual', over: { condition: 'Len(body.string) > 1' }, pages: false },
    ];
    for (const c of cases) {
      const r = await source.queryLogs(q(c.over), signal);
      const predicted = pagesLogList({
        mode: 'logs',
        sortColumn: c.over.sort?.column ?? 'time',
        residual: residualOf(c.over.condition ?? null, 'log_record'),
        idTable: false,
      });
      expect(predicted, c.name).toBe(c.pages);
      expect(r.next !== null, c.name).toBe(c.pages);
    }
  });

  test('a list the predicate refuses gets all its rows up to the limit in one statement', async () => {
    const { source } = recording();
    const signal = new AbortController().signal;
    const sev = await source.queryLogs(q({ sort: { column: 'severity', dir: 'desc' }, limit: 1000 }), signal);
    expect(sev.rows).toHaveLength(N);
    expect(sev.next).toBeNull();
    const res = await source.queryLogs(q({ condition: 'Len(body.string) > 1', limit: 1000 }), signal);
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.next).toBeNull();
  });

  test('spans: start sort pages, a residual or another sort does not; a long window takes traces over', () => {
    expect(
      pagesSpanList({ mode: 'spans', sortColumn: 'start', residual: null, idTable: false, longWindow: true }),
    ).toBe(true);
    expect(
      pagesSpanList({
        mode: 'traces',
        sortColumn: 'start',
        residual: null,
        idTable: false,
        longWindow: true,
      }),
    ).toBe(false);
    expect(
      pagesSpanList({
        mode: 'spans',
        sortColumn: 'duration',
        residual: null,
        idTable: false,
        longWindow: false,
      }),
    ).toBe(false);
    expect(
      pagesSpanList({
        mode: 'spans',
        sortColumn: 'start',
        residual: 'Len(name) > 1',
        idTable: false,
        longWindow: false,
      }),
    ).toBe(false);
    expect(residualOf('Len(name) > 1', 'span')).not.toBeNull();
    expect(residualOf(null, 'span')).toBeNull();
  });
});
