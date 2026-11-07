import { beforeAll, describe, expect, test } from 'vitest';
import { anyValueToDisplay } from '../../src/model/anyvalue.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { parseTraceId } from '../../src/model/ids.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { type LogRef, type LogRow, type LogTraceRow, logRef } from '../../src/viewer/data/log-query.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import type { LogQuery } from '../../src/viewer/data/results.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../test-support/format4-fixture.js';
import {
  attr,
  gauge,
  type JsonObject,
  logsRequest,
  metricsRequest,
  span,
  traceRequest,
} from '../../test-support/otlp-builders.js';
import { EPOCH_NS, otlp } from '../../test-support/writer-deps.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const BASE = BigInt(EPOCH_NS);
const OFFSET = 123_456n;
const ns = (ms: number): bigint => BigInt(Math.round(ms * 1e6));
const str = (v: string): JsonObject => ({ stringValue: v });
const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
const abs = (ms: number): string => String(BASE + OFFSET + ns(ms));

interface L {
  id: string;
  svc: string;
  host: string | null;
  /** Milliseconds from the first log; null for a record with neither time. */
  ms: number | null;
  /** Set for a record that has only an observed time. */
  observed?: true;
  sev: number;
  trace?: number;
  body: JsonObject;
}

const user = (n: number): JsonObject => str(`user ${n} logged in`);
const failed = (n: number): JsonObject => str(`failed to connect to db ${n}`);

// Partition 0 and partition 1 (the writer sorts a file by service, then time). Bodies: strings, an int and maps.
const P0: L[] = [
  { id: 'a1', svc: 'svc-a', host: 'host-1', ms: 0, sev: 9, body: user(1) },
  { id: 'a2', svc: 'svc-a', host: 'host-1', ms: 10, sev: 17, trace: 1, body: failed(10) },
  { id: 'b1', svc: 'svc-b', host: 'host-1', ms: 10, sev: 5, body: user(3) },
  { id: 'b2', svc: 'svc-b', host: 'host-1', ms: 20, sev: 13, trace: 1, body: failed(11) },
  { id: 'c1', svc: 'svc-c', host: 'host-2', ms: 30, sev: 21, body: { intValue: '42' } },
];
const P1: L[] = [
  { id: 'a3', svc: 'svc-a', host: 'host-1', ms: 40, sev: 1, body: user(2) },
  { id: 'a4', svc: 'svc-a', host: 'host-1', ms: 70, sev: 17, trace: 2, body: failed(12) },
  { id: 'b3', svc: 'svc-b', host: 'host-1', ms: 50, sev: 9, trace: 1, body: user(4) },
  { id: 'b4', svc: 'svc-b', host: 'host-2', ms: 55, observed: true, sev: 9, body: failed(13) },
  {
    id: 'b5',
    svc: 'svc-b',
    host: null,
    ms: null,
    sev: 9,
    body: { kvlistValue: { values: [attr('k', str('v'))] } },
  },
  {
    id: 'c2',
    svc: 'svc-c',
    host: 'host-2',
    ms: 60,
    sev: 24,
    body: { kvlistValue: { values: [attr('k', str('w'))] } },
  },
];

function logsOf(rows: L[]): ReturnType<typeof otlp> {
  const resourceLogs: unknown[] = [];
  for (const l of rows) {
    const record: JsonObject = {
      severityNumber: l.sev,
      body: l.body,
      attributes: [attr('id', str(l.id))],
      ...(l.ms === null
        ? {}
        : l.observed === true
          ? { observedTimeUnixNano: abs(l.ms) }
          : { timeUnixNano: abs(l.ms) }),
      ...(l.trace === undefined ? {} : { traceId: hex(l.trace, 32), spanId: hex(l.trace, 16) }),
    };
    const r = logsRequest(
      [record],
      [attr('service.name', str(l.svc)), ...(l.host === null ? [] : [attr('host.name', str(l.host))])],
    ) as { resourceLogs: unknown[] };
    resourceLogs.push(...r.resourceLogs);
  }
  return otlp({ resourceLogs } as never);
}

function pointsOf(msList: number[]): ReturnType<typeof otlp> {
  return otlp(
    metricsRequest(
      [
        gauge(
          'm',
          msList.map((ms) => ({ timeUnixNano: abs(ms), asDouble: ms })),
        ),
      ],
      [attr('service.name', str('svc-a'))],
    ) as never,
  );
}

const T1 = parseTraceId(hex(1, 32), 'test');
const T2 = parseTraceId(hex(2, 32), 'test');
let f: Format4Fixture;
let db: TestDb;
let ds: DataSource;

const fresh = (): DataSource =>
  createDuckDbDataSource({
    engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
    manifest: f.manifest,
  });

beforeAll(async () => {
  f = await buildFormat4Report([logsOf(P0), logsOf(P1), pointsOf([5, 15, 25]), pointsOf([55, 105])], {
    close: false,
  });
  db = await openFixtureDb(f);
  ds = fresh();
});

const rel = (ms: number): number => Number(BASE + OFFSET + ns(ms) - f.epoch);
const idOf = (r: LogRow): string => {
  const v = r.log.attributes.get('id');
  return v === undefined ? '' : anyValueToDisplay(v);
};
const ids = (rows: readonly LogRow[]): string[] => rows.map(idOf);

/** The statements a call sends: `arrow` queries and `exec` DDL, counted separately. */
async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; arrow: number; exec: number }> {
  const before = db.connector.requests.length;
  const value = await fn();
  const sent = db.connector.requests.slice(before);
  return {
    value,
    arrow: sent.filter((r) => r.type === 'arrow').length,
    exec: sent.filter((r) => r.type === 'exec').length,
  };
}

const ALL = ['rows', 'facets', 'timeline'] as const;
const query = (over: Partial<LogQuery> = {}): LogQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'logs',
  sort: { column: 'time', dir: 'asc' },
  limit: 100,
  needs: [...ALL],
  facetKeys: null,
  ...over,
});
const refOf = async (id: string): Promise<LogRef> => {
  const r = (await ds.queryLogs(query({ needs: ['rows'] }))).rows as LogRow[];
  const row = r.find((x) => idOf(x) === id);
  if (row === undefined) throw new Error(`no log ${id}`);
  return row.ref;
};

describe('queryLogs', () => {
  test('a severity condition returns exactly those logs with facets over them and exact buckets', async () => {
    const r = await counted(() => fresh().queryLogs(query({ condition: 'severity_number >= 17' })));
    const q = r.value;
    expect(q.mode).toBe('logs');
    expect(ids(q.rows as LogRow[])).toEqual(['a2', 'c1', 'c2', 'a4']);
    expect(q.total).toBe(4);
    expect(q.matched).toBe(4);
    expect(q.residual).toBeNull();
    expect(q.facets.top('severity', 5)).toEqual([
      { value: 'error', count: 2 },
      { value: 'fatal', count: 2 },
    ]);
    expect(q.facets.top('service.name', 5)).toEqual([
      { value: 'svc-a', count: 2 },
      { value: 'svc-c', count: 2 },
    ]);
    expect(q.facets.top('id', 5).map((x) => x.value)).toEqual(['a2', 'a4', 'c1', 'c2']);
    expect(q.buckets.keys).toEqual(['unspecified', 'trace', 'debug', 'info', 'warn', 'error', 'fatal']);
    expect(q.buckets.total('error')).toBe(2);
    expect(q.buckets.total('fatal')).toBe(2);
    expect(q.buckets.total('info')).toBe(0);
    // rows, core facets, attribute facets, timeline
    expect(r.arrow).toBe(4);
    expect(r.exec).toBe(0);
  });

  test('rows come back relative to the epoch with their ref, service, host and time source', async () => {
    const rows = (await ds.queryLogs(query({ needs: ['rows'] }))).rows as LogRow[];
    expect(rows).toHaveLength(11);
    const a1 = rows.find((r) => idOf(r) === 'a1');
    expect(a1).toMatchObject({ service: 'svc-a', host: 'host-1', time: rel(0), timeSource: 'time' });
    expect(a1?.ref).toBe(logRef(a1?.n ?? -1, a1?.i ?? -1));
    expect(rows.find((r) => idOf(r) === 'b4')?.timeSource).toBe('observed');
    const b5 = rows.find((r) => idOf(r) === 'b5');
    expect(b5).toMatchObject({ host: null, time: 0, timeSource: 'none' });
    expect(b5?.resource.attributes.get('service.name')).toBeDefined();
    // time order; the log with no time sits at 0, tied with a1 (the first log) and ordered after it by file and row
    expect(ids(rows).slice(0, 3)).toEqual(['a1', 'b5', 'a2']);
    const bySev = (
      (await ds.queryLogs(query({ needs: ['rows'], sort: { column: 'severity', dir: 'desc' }, limit: 2 })))
        .rows as LogRow[]
    ).map(idOf);
    expect(bySev).toEqual(['c2', 'c1']);
    await expect(ds.queryLogs(query({ sort: { column: 'nope', dir: 'asc' } }))).rejects.toMatchObject({
      code: 'usage',
    });
    await expect(ds.queryLogs(query({ mode: 'patterns' as never }))).rejects.toMatchObject({
      code: 'usage',
    });
  });

  test('traces mode returns one row per trace, matched counts the logs that carry a trace id', async () => {
    const r = await counted(() =>
      fresh().queryLogs(query({ mode: 'traces', needs: ['rows'], sort: { column: 'first', dir: 'asc' } })),
    );
    const q = r.value;
    expect(q.mode).toBe('traces');
    const rows = q.rows as LogTraceRow[];
    expect(rows.map((x) => x.traceId)).toEqual([T1, T2]);
    expect(q.total).toBe(2);
    expect(q.matched).toBe(4);
    expect(rows[0]).toMatchObject({
      logs: 3,
      first: rel(10),
      last: rel(50),
      maxSeverity: 17,
      services: ['svc-a', 'svc-b'],
    });
    expect(r.arrow).toBe(2); // the traces, the matched count
    const bySev = await ds.queryLogs(
      query({ mode: 'traces', needs: ['rows'], sort: { column: 'logs', dir: 'asc' } }),
    );
    expect((bySev.rows as LogTraceRow[]).map((x) => x.traceId)).toEqual([T2, T1]);
  });

  test('traceId narrows to one trace, pruned through the traces partitions', async () => {
    const r = await counted(() => fresh().queryLogs(query({ traceId: T1, needs: ['rows'] })));
    expect(ids(r.value.rows as LogRow[])).toEqual(['a2', 'b2', 'b3']);
    expect(r.arrow).toBe(2); // trace partitions, rows
    const none = await ds.queryLogs(query({ traceId: parseTraceId(hex(99, 32), 'test'), needs: ['rows'] }));
    expect(none.rows).toEqual([]);
  });

  test('a residual condition re-checks logs in the browser and marks the result', async () => {
    const condition = 'Len(body.string) > 20';
    const rowsOnly = await counted(() => fresh().queryLogs(query({ condition, needs: ['rows'] })));
    expect(rowsOnly.value.residual).toBe('Len(body.string) > 20');
    expect(ids(rowsOnly.value.rows as LogRow[])).toEqual(['a2', 'b2', 'b4', 'a4']);
    expect(rowsOnly.value.total).toBe(4);
    expect(rowsOnly.value.matched).toBe(4);
    expect(rowsOnly.exec).toBe(0);

    const all = await counted(() => fresh().queryLogs(query({ condition })));
    expect(all.value.residual).toBe('Len(body.string) > 20');
    expect(all.value.total).toBe(4);
    expect(all.value.facets.top('severity', 5)).toEqual([
      { value: 'error', count: 2 },
      { value: 'info', count: 1 },
      { value: 'warn', count: 1 },
    ]);
    expect(all.value.buckets.total('error')).toBe(2);
    expect(all.arrow).toBe(5); // candidates, rows, core and attribute facets, timeline
    expect(all.exec).toBe(2); // the id table: created, dropped
    expect(db.rows("SELECT table_name FROM duckdb_tables() WHERE table_name LIKE 'otel_residual%'")).toEqual(
      [],
    );

    const mixed = await ds.queryLogs(
      query({ condition: 'severity_number == 17 and Len(body.string) > 20', needs: ['rows'] }),
    );
    expect(ids(mixed.rows as LogRow[])).toEqual(['a2', 'a4']);

    const traces = await ds.queryLogs(
      query({ condition, mode: 'traces', needs: ['rows'], sort: { column: 'first', dir: 'asc' } }),
    );
    expect((traces.rows as LogTraceRow[]).map((x) => x.traceId)).toEqual([T1, T2]);
    expect(traces.matched).toBe(3); // b4 carries no trace id
  });

  test('a window that prunes every partition returns empty results without a query', async () => {
    const r = await counted(() => ds.queryLogs(query({ window: { start: -2e9, end: -1e9 } })));
    expect(r.value.rows).toEqual([]);
    expect(r.value.total).toBe(0);
    expect(r.value.buckets.length).toBe(0);
    expect(r.arrow + r.exec).toBe(0);
  });

  test('needs restricts the work', async () => {
    expect((await counted(() => fresh().queryLogs(query({ needs: ['rows'], text: 'user' })))).arrow).toBe(1);
    expect((await counted(() => fresh().queryLogs(query({ needs: ['timeline'], text: 'user' })))).arrow).toBe(
      1,
    );
    const keyed = await counted(() =>
      fresh().queryLogs(query({ needs: ['facets'], facetKeys: ['service.name'] })),
    );
    expect(keyed.arrow).toBe(1);
    expect(keyed.value.facets.top('service.name', 5).map((x) => x.count)).toEqual([5, 4, 2]);
  });

  test('a signal aborted mid-flight rejects with AbortError and leaves no table', async () => {
    const ctl = new AbortController();
    const p = ds.queryLogs(query({ condition: 'Len(body.string) > 20' }), ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(db.rows("SELECT table_name FROM duckdb_tables() WHERE table_name LIKE 'otel_residual%'")).toEqual(
      [],
    );
    expect((await ds.queryLogs(query({ needs: ['rows'] }))).total).toBe(11);
  });
});

describe('getLog', () => {
  test('finds a log by ref in either partition, one statement', async () => {
    const a1 = await refOf('a1');
    const a3 = await refOf('a3');
    expect(refOfParts(a1).n).not.toBe(refOfParts(a3).n);
    const r = await counted(() => fresh().getLog(a3));
    expect(idOf(r.value)).toBe('a3');
    expect(r.value.ref).toBe(a3);
    expect(r.arrow).toBe(1);
    expect(idOf(await ds.getLog(a1))).toBe('a1');
  });

  test('an absent row, a partition without logs and a partition that does not exist are a usage error', async () => {
    const real = refOfParts(await refOf('a1'));
    const pointsPartition = f.manifest.partitions.find((p) => p.files.logs === undefined)?.n ?? -1;
    for (const ref of [logRef(real.n, 9999), logRef(pointsPartition, 0), logRef(999, 0)]) {
      await expect(ds.getLog(ref)).rejects.toSatisfy(
        (e: unknown) => e instanceof OtelHtmlError && e.code === 'usage' && /no such log/.test(e.message),
      );
    }
  });
});

function refOfParts(ref: LogRef): { n: number; i: number } {
  const [n, i] = ref.split('.');
  return { n: Number(n), i: Number(i) };
}

describe('surroundingLogs', () => {
  test('n on each side of a log in the same stream, across the partition boundary', async () => {
    const a3 = await refOf('a3');
    const r = await counted(() => fresh().surroundingLogs(a3, 1));
    expect(ids(r.value.before)).toEqual(['a2']);
    expect(idOf(r.value.log)).toBe('a3');
    expect(ids(r.value.after)).toEqual(['a4']);
    expect(r.arrow).toBe(3); // the log, before, after
    const wide = await ds.surroundingLogs(await refOf('a3'), 5);
    expect(ids(wide.before)).toEqual(['a1', 'a2']); // time order; a1, a2 are in the other partition
    expect(ids(wide.after)).toEqual(['a4']);
    expect(refOfParts(await refOf('a2')).n).not.toBe(refOfParts(a3).n);
  });

  test('only the same service and host count; a log without a host matches a log without one', async () => {
    const b2 = await ds.surroundingLogs(await refOf('b2'), 5);
    expect(ids(b2.before)).toEqual(['b1']); // b4 is svc-b on host-2, b5 has no host
    expect(ids(b2.after)).toEqual(['b3']);
    const b5 = await ds.surroundingLogs(await refOf('b5'), 5);
    expect(ids(b5.before)).toEqual([]);
    expect(ids(b5.after)).toEqual([]); // the only svc-b log with no host
  });

  test('n of 0 returns the log alone after one statement; a bad count is a usage error before any', async () => {
    const ref = await refOf('a1');
    const zero = await counted(() => fresh().surroundingLogs(ref, 0));
    expect(zero.value.before).toEqual([]);
    expect(zero.value.after).toEqual([]);
    expect(zero.arrow).toBe(1);
    for (const n of [-1, 1.5, Number.NaN]) {
      const r = await counted(() => ds.surroundingLogs(ref, n).catch((e: unknown) => e));
      expect(r.arrow).toBe(0);
      expect((r.value as OtelHtmlError).code).toBe('usage');
    }
  });
});

describe('traceLogs', () => {
  test('lists the trace logs in time order, pruned through the traces partitions', async () => {
    const r = await counted(() => fresh().traceLogs(T1));
    expect(ids(r.value)).toEqual(['a2', 'b2', 'b3']);
    expect(r.arrow).toBe(2); // trace partitions, logs
    expect(ids(await ds.traceLogs(T2))).toEqual(['a4']);
  });

  test('a trace with no traces row reads every logs file and finds nothing', async () => {
    const texts: string[] = [];
    const base = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
    const engine: QueryEngine = {
      ...base,
      query: (q, signal) => {
        texts.push(q.toString());
        return base.query(q, signal);
      },
    };
    const source = createDuckDbDataSource({ engine, manifest: f.manifest });
    expect(await source.traceLogs(parseTraceId(hex(99, 32), 'test'))).toEqual([]);
    expect(texts).toHaveLength(2);
    expect(texts[1]).not.toMatch(/"filename" IN/);
    texts.length = 0;
    await source.traceLogs(T1);
    expect(texts[1]).toMatch(/"filename" IN/);
  });
});

describe('patterns', () => {
  const q = (over: Partial<Parameters<DataSource['patterns']>[0]> = {}) => ({
    window: null,
    sort: { column: 'count' as const, dir: 'desc' as const },
    limit: 10,
    ...over,
  });

  test('two partitions with the same template combine into one row with a regex that matches its sample', async () => {
    const r = await counted(() => fresh().patterns(q()));
    expect(r.arrow).toBe(1);
    const rows = r.value.rows;
    expect(r.value.total).toBe(rows.length);
    expect(rows.map((x) => x.id)).toEqual(rows.map((_, i) => i));
    const users = rows.find((x) => x.template === 'user <*> logged in');
    expect(users).toMatchObject({ count: 4, first: rel(0), last: rel(50), sample: 'user 1 logged in' });
    expect(users?.severities).toMatchObject({ info: 2, debug: 1, trace: 1, error: 0 });
    expect(new RegExp(users?.regex ?? '').test('user 77 logged in')).toBe(true);
    expect(new RegExp(users?.regex ?? '').test('user 77 logged out')).toBe(false);
    const failed = rows.find((x) => x.template === 'failed to connect to db <*>');
    expect(failed?.count).toBe(4);
    expect(failed?.severities).toMatchObject({ error: 2, warn: 1, info: 1 });
    for (const row of rows) expect(new RegExp(row.regex).test(row.sample)).toBe(true);
    // a template whose logs have no time sits at 0
    expect(rows.find((x) => x.template === '{"k":"v"}')).toMatchObject({ first: 0, last: 0 });
  });

  test('a window keeps the templates whose combined range overlaps it; sort and limit apply', async () => {
    const late = await ds.patterns(q({ window: { start: rel(65), end: rel(80) } }));
    expect(late.rows.map((x) => [x.template, x.count])).toEqual([['failed to connect to db <*>', 4]]);
    const mid = await ds.patterns(q({ window: { start: rel(25), end: rel(35) } }));
    expect(mid.rows.map((x) => x.template)).toEqual([
      'failed to connect to db <*>',
      'user <*> logged in',
      '<*>',
    ]);
    const first = await ds.patterns(q({ sort: { column: 'first', dir: 'desc' }, limit: 1 }));
    expect(first.rows.map((x) => x.template)).toEqual(['{"k":"w"}']);
    expect(first.total).toBeGreaterThan(1);
    await expect(ds.patterns(q({ sort: { column: 'nope' as never, dir: 'asc' } }))).rejects.toMatchObject({
      code: 'usage',
    });
  });
});

describe('metricPoints', () => {
  test('counts the points of every resource per bucket in one statement', async () => {
    const r = await counted(() => fresh().metricPoints());
    expect(r.arrow).toBe(1);
    expect(r.value.keys).toEqual(['points']);
    expect(r.value.total('points')).toBe(5);
  });
});

describe('resourceValues', () => {
  test('the distinct values across spans, logs and points, sorted, in one statement', async () => {
    const r = await counted(() => fresh().resourceValues('service.name'));
    expect(r.arrow).toBe(1);
    expect(r.value).toEqual({ values: ['svc-a', 'svc-b', 'svc-c'], kind: 'string', capped: false });
    expect(await ds.resourceValues('host.name')).toEqual({
      values: ['host-1', 'host-2'],
      kind: 'string',
      capped: false,
    });
    expect(await ds.resourceValues('nope')).toEqual({ values: [], kind: 'string', capped: false });
  });

  test('capped when cap + 1 values exist; the cap values kept are the first sorted', async () => {
    const small = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
      manifest: f.manifest,
      caps: { facetValueCap: 2, facetKeyCap: 500 },
    });
    expect(await small.resourceValues('service.name')).toEqual({
      values: ['svc-a', 'svc-b'],
      kind: 'string',
      capped: true,
    });
    const exact = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
      manifest: f.manifest,
      caps: { facetValueCap: 3, facetKeyCap: 500 },
    });
    expect((await exact.resourceValues('service.name')).capped).toBe(false);
  });

  test('kinds merge: one kind stays, differing kinds are mixed', async () => {
    const spanReq = otlp(
      traceRequest(
        [span({ traceId: hex(5, 32), spanId: hex(5, 16) })],
        [attr('service.name', str('s')), attr('host.name', str('h1')), attr('port', { intValue: '80' })],
      ) as never,
    );
    const logReq = otlp(
      logsRequest(
        [{ severityNumber: 9, body: str('x') }],
        [
          attr('service.name', str('s')),
          attr('host.name', { intValue: '7' }),
          attr('port', { intValue: '81' }),
        ],
      ) as never,
    );
    const g = await buildFormat4Report([spanReq, logReq], { close: false });
    const gdb = await openFixtureDb(g);
    const source = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(gdb.connector, silentLogger), gdb),
      manifest: g.manifest,
    });
    expect(await source.resourceValues('host.name')).toEqual({
      values: ['7', 'h1'],
      kind: 'mixed',
      capped: false,
    });
    expect(await source.resourceValues('port')).toEqual({ values: ['80', '81'], kind: 'int', capped: false });
    // one text under two kinds is one value: cap 2 over ('3' as int and string, 'a') keeps both, not capped
    const t = (v: JsonObject) => [attr('service.name', str('s')), attr('host.name', v)];
    const h = await buildFormat4Report(
      [
        otlp(
          traceRequest([span({ traceId: hex(6, 32), spanId: hex(6, 16) })], t({ intValue: '3' })) as never,
        ),
        otlp(logsRequest([{ severityNumber: 9, body: str('x') }], t(str('3'))) as never),
        otlp(logsRequest([{ severityNumber: 9, body: str('y') }], t(str('a'))) as never),
      ],
      { close: false },
    );
    const hdb = await openFixtureDb(h);
    const two = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(hdb.connector, silentLogger), hdb),
      manifest: h.manifest,
      caps: { facetValueCap: 2, facetKeyCap: 500 },
    });
    expect(await two.resourceValues('host.name')).toEqual({
      values: ['3', 'a'],
      kind: 'mixed',
      capped: false,
    });
    await source.close();
  });

  test('the partition lookup of traceLogs and a traceId query receives the abort signal', async () => {
    const base = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
    const signals: (AbortSignal | undefined)[] = [];
    const source = createDuckDbDataSource({
      engine: {
        ...base,
        query: (q, signal) => {
          signals.push(signal);
          return base.query(q, signal);
        },
      },
      manifest: f.manifest,
    });
    const ctl = new AbortController();
    await source.traceLogs(T1, ctl.signal);
    await source.queryLogs(query({ traceId: T1, needs: ['rows'] }), ctl.signal);
    expect(signals).toHaveLength(4);
    expect(signals.every((x) => x === ctl.signal)).toBe(true);
  });
});
