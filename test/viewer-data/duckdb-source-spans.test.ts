import { beforeAll, describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { parseTraceId } from '../../src/model/ids.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import { residualRows } from '../../src/viewer/data/residual.js';
import type { SpanQuery, SpanRow, TraceRow } from '../../src/viewer/data/results.js';
import { toNumber } from '../../src/viewer/data/span-results.js';
import { alignLongWindow } from '../../src/viewer/data/time-window.js';
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
const T1 = parseTraceId(hex(1, 32), 'test');
const T2 = parseTraceId(hex(2, 32), 'test');
const T3 = parseTraceId(hex(3, 32), 'test');

interface S {
  trace: number;
  id: number;
  parent?: number;
  svc: string;
  name: string;
  startMs: number;
  durMs: number;
  error?: boolean;
  attrs?: JsonObject[];
}

/** One partition of spans (`otlp` takes one signal per request, so logs are their own partitions). */
function request(spans: S[]) {
  const resourceSpans: unknown[] = [];
  for (const svc of [...new Set(spans.map((s) => s.svc))]) {
    const mine = spans
      .filter((s) => s.svc === svc)
      .map((s) =>
        span({
          traceId: hex(s.trace, 32),
          spanId: hex(s.id, 16),
          ...(s.parent === undefined ? {} : { parentSpanId: hex(s.parent, 16) }),
          name: s.name,
          startTimeUnixNano: String(BASE + ns(s.startMs)),
          endTimeUnixNano: String(BASE + ns(s.startMs) + ns(s.durMs)),
          ...(s.error === true ? { status: { code: 2 } } : {}),
          attributes: s.attrs ?? [],
        }),
      );
    const r = traceRequest(mine, [attr('service.name', str(svc))]) as { resourceSpans: unknown[] };
    resourceSpans.push(...r.resourceSpans);
  }
  return otlp({ resourceSpans } as never);
}

/** One partition of logs, one per entry of `traces` (a trace number). */
function logs(traces: number[]) {
  return otlp(
    logsRequest(
      traces.map((t) => logRecord({ traceId: hex(t, 32), body: str(`log of ${t}`) })),
      [attr('service.name', str('svc-a'))],
    ) as never,
  );
}

// Spans in three partitions, logs of trace 1 in two more (log-only partitions have no spans file): trace 1 has 3 spans, 1 error, 3 logs.
const P0: S[] = [
  { trace: 1, id: 1, svc: 'svc-a', name: 'GET /users', startMs: 0, durMs: 100 },
  {
    trace: 2,
    id: 4,
    svc: 'svc-a',
    name: 'POST /orders',
    startMs: 200,
    durMs: 300,
    error: true,
    attrs: [attr('k.s', str('y'))],
  },
];
const P1: S[] = [
  {
    trace: 1,
    id: 2,
    parent: 1,
    svc: 'svc-b',
    name: 'SELECT',
    startMs: 10,
    durMs: 50,
    attrs: [attr('k.s', str('x'))],
  },
  { trace: 3, id: 6, svc: 'svc-a', name: 'GET /users', startMs: 1000, durMs: 10 },
  { trace: 3, id: 7, parent: 6, svc: 'svc-b', name: 'SELECT', startMs: 1002, durMs: 2 },
];
const P2: S[] = [
  { trace: 1, id: 3, parent: 1, svc: 'svc-b', name: 'COMMIT', startMs: 60, durMs: 20, error: true },
];

let f: Format4Fixture;
let db: TestDb;
let ds: DataSource;

beforeAll(async () => {
  f = await buildFormat4Report([request(P0), logs([1]), request(P1), request(P2), logs([1, 1])], {
    close: false,
  });
  db = await openFixtureDb(f);
  ds = createDuckDbDataSource({
    engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
    manifest: f.manifest,
  });
});

const ALL = ['rows', 'facets', 'timeline', 'durations', 'groups'] as const;
const query = (over: Partial<SpanQuery> = {}): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 100,
  groupBy: null,
  measureBy: null,
  needs: ['rows', 'facets', 'timeline', 'durations'],
  facetKeys: null,
  ...over,
});

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

const spanRows = (rows: readonly (SpanRow | TraceRow)[]): SpanRow[] => rows as SpanRow[];
const traceRows = (rows: readonly (SpanRow | TraceRow)[]): TraceRow[] => rows as TraceRow[];

describe('querySpans', () => {
  test('needs ["buckets"] sends one statement and fills the buckets only; with "timeline" the latency comes too', async () => {
    // a fresh coordinator per call: the shared one caches by SQL text, which would hide the statements
    // from the counts here and from the tests that count after this one
    const fresh = () =>
      createDuckDbDataSource({
        engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
        manifest: f.manifest,
      });
    const full = await fresh().querySpans(query({ needs: ['timeline'] }));
    const only = await counted(() => fresh().querySpans(query({ needs: ['buckets'] })));
    expect(only.arrow).toBe(1);
    expect(only.value.buckets).toEqual(full.buckets);
    expect(only.value.red).toBeNull();
    const both = await counted(() => fresh().querySpans(query({ needs: ['timeline', 'buckets'] })));
    expect(both.arrow).toBe(1);
    expect(both.value.red).toEqual(full.red);
    const residual = { condition: 'Len(name) > 7' };
    expect((await fresh().querySpans(query({ ...residual, needs: ['buckets'] }))).buckets).toEqual(
      (await fresh().querySpans(query({ ...residual, needs: ['timeline'] }))).buckets,
    );
  });

  test('needs ["total"] counts in one statement what "rows" reports, in both modes and under a browser condition', async () => {
    // a fresh data source per call: the shared coordinator caches by SQL text, which would hide statements from
    // the counts of the tests that count after this one
    const fresh = () =>
      createDuckDbDataSource({
        engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
        manifest: f.manifest,
      });
    const counted1 = await counted(() => fresh().querySpans(query({ needs: ['total'], limit: 1 })));
    expect(counted1.arrow).toBe(1);
    expect(counted1.value.rows).toEqual([]);
    for (const over of [
      {},
      { mode: 'traces' as const, sort: { column: 'start', dir: 'asc' as const } },
      { text: 'select' },
    ]) {
      const rows = await fresh().querySpans(query({ ...over, needs: ['rows'] }));
      expect((await fresh().querySpans(query({ ...over, needs: ['total'], limit: 1 }))).total).toBe(
        rows.total,
      );
    }
    const residual = { condition: 'Len(name) > 7' };
    const kept = await fresh().querySpans(query({ ...residual, needs: ['rows'] }));
    expect(
      (await fresh().querySpans(query({ ...residual, needs: ['total', 'facets'], limit: 1 }))).total,
    ).toBe(kept.total);
  });

  test('an unconditioned trace list reads traces alone; a window, a condition or a text keep the spans path', async () => {
    const fresh = () =>
      createDuckDbDataSource({
        engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
        manifest: f.manifest,
      });
    const spanStatements = async (over: Partial<SpanQuery>): Promise<string[]> => {
      const before = db.connector.requests.length;
      await fresh().querySpans(query({ mode: 'traces', needs: ['rows', 'total'], ...over }));
      return db.connector.requests
        .slice(before)
        .map((r) => r.sql)
        .filter((q) => /\bspans\b/.test(q));
    };
    expect(await spanStatements({})).toEqual([]);
    const window = { start: 0, end: 1e12 };
    for (const over of [{ window }, { condition: 'name == "COMMIT"' }, { text: 'select' }])
      expect((await spanStatements(over)).length, JSON.stringify(over)).toBeGreaterThan(0);
    const all = await fresh().querySpans(query({ mode: 'traces', needs: ['rows', 'total'] }));
    const spans = await fresh().querySpans(
      query({ mode: 'traces', needs: ['rows', 'total'], condition: 'name != "no-such"' }),
    );
    expect(all.rows).toEqual(spans.rows);
    expect(all.total).toBe(spans.total);
  });

  test('a negative or fractional limit is a usage error', async () => {
    for (const limit of [-1, 1.5, Number.NaN]) {
      await expect(ds.querySpans(query({ limit }))).rejects.toMatchObject({
        code: 'usage',
      });
    }
  });

  test('an error condition returns exactly the error spans, facets over them, exact buckets and no residual', async () => {
    const r = await ds.querySpans(query({ condition: 'status.code == 2' }));
    expect(spanRows(r.rows).map((x) => x.span.name)).toEqual(['COMMIT', 'POST /orders']);
    expect(r.total).toBe(2);
    expect(r.residual).toBeNull();
    expect(r.facets.top('status.code', 5)).toEqual([{ value: 'error', count: 2 }]);
    expect(r.facets.top('service.name', 5).map((x) => x.count)).toEqual([1, 1]);
    expect(r.facets.top('k.s', 5)).toEqual([{ value: 'y', count: 1 }]);
    // exact buckets: both errors are counted, none ok
    const keys = r.buckets.keys;
    expect(keys).toEqual(['ok', 'error', 'unset']);
    expect(r.buckets.total('error')).toBe(2);
    expect(r.buckets.total('ok')).toBe(0);
    expect(r.red?.counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(r.durations.summary?.count).toBe(2);
    expect(r.durations.summary?.max).toBe(300e6);
    expect(r.durations.bins.reduce((a, b) => a + b.count, 0)).toBe(2);
    expect(r.tables.resources.length).toBeGreaterThan(0);
    // refs index the returned tables
    for (const row of spanRows(r.rows)) expect(r.tables.resources[row.span.resource]).toBeDefined();
  });

  test('rows come back relative to the epoch, with a duration, sorted as asked', async () => {
    const r = await ds.querySpans(query({ needs: ['rows'], sort: { column: 'duration', dir: 'desc' } }));
    const rows = spanRows(r.rows);
    expect(rows.map((x) => x.durationNs)).toEqual([300e6, 100e6, 50e6, 20e6, 10e6, 2e6]);
    expect(rows[1]?.span.start).toBe(0);
    expect(rows[1]?.span.end).toBe(100e6);
    expect(rows[1]?.service).toBe('svc-a');
    expect(r.total).toBe(6);
    await expect(ds.querySpans(query({ sort: { column: 'nope', dir: 'asc' } }))).rejects.toMatchObject({
      code: 'usage',
    });
  });

  test('traces mode returns one row per matching trace with the root summary from traces', async () => {
    const r = await ds.querySpans(
      query({ mode: 'traces', needs: ['rows'], sort: { column: 'start', dir: 'asc' } }),
    );
    const rows = traceRows(r.rows);
    expect(rows.map((x) => x.traceId)).toEqual([T1, T2, T3]);
    expect(r.total).toBe(3);
    expect(rows[1]).toMatchObject({
      rootSummary: { service: 'svc-a', name: 'POST /orders', resource: 'POST /orders' },
      start: 200e6,
      durationNs: 300e6,
      spans: 1,
      errors: 1,
    });
    expect(rows[2]?.durationNs).toBe(10e6);
  });

  test('a trace split across three partitions aggregates to one row and getTrace returns all its spans with logCount summed', async () => {
    const r = await ds.querySpans(
      query({ mode: 'traces', needs: ['rows'], condition: `trace_id.string == "${T1}"` }),
    );
    const rows = traceRows(r.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      traceId: T1,
      spans: 3,
      errors: 1,
      start: 0,
      durationNs: 100e6,
      rootSummary: { service: 'svc-a', name: 'GET /users' },
    });
    const detail = await ds.getTrace(T1);
    expect(detail.spans.map((s) => s.span.name)).toEqual(['GET /users', 'SELECT', 'COMMIT']);
    expect(detail.logCount).toBe(3);
    expect(detail.tree.roots).toHaveLength(1);
    expect(detail.resources(detail.spans[0]?.span.resource ?? (0 as never)).attributes.size).toBeGreaterThan(
      0,
    );
    // a trace without logs counts none
    expect((await ds.getTrace(T3)).logCount).toBe(0);
  });

  test('getTrace and serviceShare bound the span statement in time, and a trace over several partitions keeps all its spans', async () => {
    const fresh = () =>
      createDuckDbDataSource({
        engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
        manifest: f.manifest,
      });
    const spanSql = async (fn: () => Promise<unknown>): Promise<string[]> => {
      const before = db.connector.requests.length;
      await fn();
      return db.connector.requests
        .slice(before)
        .map((r) => r.sql)
        .filter((q) => q.includes('spans') && q.includes('span_id') && q.includes('trace_id'));
    };
    const get = await spanSql(() => fresh().getTrace(T2));
    expect(get.length).toBeGreaterThan(0);
    for (const q of get) expect(q).toContain('start_time_unix_nano BETWEEN');
    const share = await spanSql(() => fresh().serviceShare(T1));
    expect(share.length).toBeGreaterThan(0);
    for (const q of share) expect(q).toContain('start_time_unix_nano BETWEEN');
    expect((await fresh().getTrace(T1)).spans).toHaveLength(3);
  });

  test('a given duration axis is counted into exactly, bin by bin', async () => {
    const base = await ds.querySpans(query({ condition: 'status.code == 2' }));
    const { min, max } = base.durations.summary ?? { min: 0, max: 0 };
    expect(max).toBeGreaterThan(min);
    // two spans: one at the minimum, one at the maximum; an axis with three bins puts them in the first and last
    const axis = [
      { fromNs: 0, toNs: min + 1 },
      { fromNs: min + 1, toNs: max },
      { fromNs: max, toNs: max + 1 },
    ];
    const r = await ds.querySpans(query({ condition: 'status.code == 2', durationAxis: axis }));
    expect(r.durations.bins).toEqual(axis.map((b, i) => ({ ...b, count: [1, 0, 1][i] })));
    expect(r.durations.summary).toEqual(base.durations.summary);
  });

  test('a served engine (no temp tables) refuses a residual aggregate and keeps the row list (D43)', async () => {
    const inner = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
    const served = createDuckDbDataSource({
      engine: { ...inner, tempTables: false },
      manifest: f.manifest,
    });
    const condition = 'Len(name) > 2';
    const before = db.connector.requests.length;
    const refused = served.querySpans(query({ condition, needs: ['facets'] }));
    await expect(refused).rejects.toMatchObject({ code: 'usage' });
    await expect(refused).rejects.toThrow(
      'this served report evaluates conditions in SQL only: "Len(name) > 2" has no SQL form; rewrite or remove it',
    );
    expect(db.connector.requests.length).toBe(before); // refused before any candidate is fetched
    const rows = await served.querySpans(query({ condition, needs: ['rows'] }));
    expect(rows.residual).toBe(condition);
    expect(rows.rows.length).toBeGreaterThan(0);
    const translatable = await served.querySpans(query({ condition: 'status.code == 2', needs: [...ALL] }));
    expect(translatable.residual).toBeNull();
    await expect(served.services({ window: null, condition, limit: 10 })).rejects.toMatchObject({
      code: 'usage',
    });
  });

  test('a residual condition (Len) re-checks rows in the browser and marks the result', async () => {
    const condition = 'Len(name) > 7';
    const rowsOnly = await counted(() => ds.querySpans(query({ condition, needs: ['rows'] })));
    expect(rowsOnly.value.residual).toBe('Len(name) > 7');
    expect(spanRows(rowsOnly.value.rows).map((x) => x.span.name)).toEqual([
      'GET /users',
      'POST /orders',
      'GET /users',
    ]);
    expect(rowsOnly.value.total).toBe(3);
    expect(rowsOnly.exec).toBe(0);

    const all = await counted(() =>
      ds.querySpans(query({ condition, needs: [...ALL], measureBy: 'span.name' })),
    );
    expect(all.value.residual).toBe('Len(name) > 7');
    expect(all.value.total).toBe(3);
    expect(all.value.facets.top('span.name', 5)).toEqual([
      { value: 'GET /users', count: 2 },
      { value: 'POST /orders', count: 1 },
    ]);
    expect(all.value.durations.summary?.count).toBe(3);
    expect(all.value.groups?.groups.map((g) => [g.group, g.count, g.sum])).toEqual([
      ['GET /users', 2, 110e6],
      ['POST /orders', 1, 300e6],
    ]);
    // one temp table: created, dropped
    expect(all.arrow).toBe(8); // candidates, rows, core and attribute facets, timeline, summary, bins, groups
    expect(all.exec).toBe(2);
    expect(db.rows("SELECT table_name FROM duckdb_tables() WHERE table_name LIKE 'otel_residual%'")).toEqual(
      [],
    );

    // combined with a translated term: the SQL narrows, the browser re-checks
    const mixed = await ds.querySpans(
      query({ condition: 'status.code == 2 and Len(name) > 7', needs: ['rows'] }),
    );
    expect(spanRows(mixed.rows).map((x) => x.span.name)).toEqual(['POST /orders']);

    // traces mode applies the residual to the spans, then lists their traces
    const traces = await ds.querySpans(query({ condition, mode: 'traces', needs: ['rows'] }));
    expect(traceRows(traces.rows).map((x) => x.traceId)).toEqual([T1, T2, T3]);
  });

  test('a window that prunes every partition returns empty results without a query', async () => {
    const r = await counted(() =>
      ds.querySpans(query({ window: { start: -2e9, end: -1e9 }, needs: [...ALL] })),
    );
    expect(r.value.rows).toEqual([]);
    expect(r.value.total).toBe(0);
    expect(r.value.durations).toEqual({ summary: null, bins: [] });
    expect(r.value.buckets.length).toBe(0);
    expect(r.arrow + r.exec).toBe(0);
  });

  test('needs restricts the work: needs ["rows"] sends one statement; all needs send six', async () => {
    expect((await counted(() => ds.querySpans(query({ needs: ['rows'], text: 'one' })))).arrow).toBe(1);
    const all = await counted(() => ds.querySpans(query({ text: 'select' })));
    expect(all.arrow).toBe(6); // rows, core facets, attribute facets, timeline, duration summary, duration bins
    const groups = await counted(() =>
      ds.querySpans(query({ text: 'select', needs: ['groups'], measureBy: 'service.name' })),
    );
    expect(groups.arrow).toBe(1);
    const traces = await counted(() => ds.querySpans(query({ text: 'commit', mode: 'traces' })));
    expect(traces.arrow).toBe(6);
    const keyed = await counted(() =>
      ds.querySpans(query({ text: 'commit', needs: ['facets'], facetKeys: ['service.name'] })),
    );
    expect(keyed.arrow).toBe(1);
  });

  test('a signal aborted mid-flight rejects with AbortError and leaves no state', async () => {
    const ctl = new AbortController();
    const p = ds.querySpans(query({ condition: 'Len(name) > 7', needs: [...ALL] }), ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const plain = new AbortController();
    const q = ds.querySpans(query({ text: 'abort-me' }), plain.signal);
    plain.abort();
    await expect(q).rejects.toMatchObject({ name: 'AbortError' });
    expect(db.rows("SELECT table_name FROM duckdb_tables() WHERE table_name LIKE 'otel_residual%'")).toEqual(
      [],
    );
    // the source still answers
    expect((await ds.querySpans(query({ needs: ['rows'] }))).total).toBe(6);
  });
});

describe('the other questions', () => {
  test('percentileOf answers from the unfiltered service/resource durations', async () => {
    expect(await ds.percentileOf('svc-a', 'GET /users', 10e6)).toBe(50);
    expect(await ds.percentileOf('svc-a', 'GET /users', 100e6)).toBe(100);
    expect(await ds.percentileOf('svc-a', 'nope', 1)).toBeNull();
  });

  test('services returns one query per table, not per service', async () => {
    const r = await counted(() => ds.services({ window: null, condition: null, limit: 10 }));
    expect(r.arrow).toBe(2);
    expect(r.value.services.map((s) => [s.service, s.requests, s.errors])).toEqual([
      ['svc-a', 3, 1],
      ['svc-b', 3, 1],
    ]);
    expect(r.value.total).toBe(2);
    const a = r.value.services.find((s) => s.service === 'svc-a');
    expect(a?.max).toBe(300e6);
    expect(a?.p50).toBeGreaterThan(0);
    expect(a?.buckets.keys).toEqual(['count']);
    expect(a?.buckets.total('count')).toBe(3);
    const limited = await ds.services({ window: null, condition: null, limit: 1 });
    expect(limited.services).toHaveLength(1);
    expect(limited.total).toBe(2);
    expect(
      (await ds.services({ window: { start: -2e9, end: -1e9 }, condition: null, limit: 5 })).services,
    ).toEqual([]);
  });

  test('serviceShare is the exclusive time per service of one trace, largest first', async () => {
    expect(await ds.serviceShare(T1)).toEqual([
      { service: 'svc-b', ns: 70e6 },
      { service: 'svc-a', ns: 30e6 },
    ]);
  });

  test('serviceShare takes its own two statements and leaves the open trace in the memo', async () => {
    // a fresh coordinator: the shared one caches by SQL text, which would hide the statements
    const fresh = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
      manifest: f.manifest,
    });
    const open = await counted(() => fresh.getTrace(T1));
    expect(open.arrow).toBe(3); // trace partitions, then spans and summary
    const share = await counted(() => fresh.serviceShare(T3));
    expect(share.arrow).toBe(2); // trace partitions, spans: no summary
    expect(share.exec).toBe(0);
    expect(share.value.map((x) => x.service).sort()).toEqual(['svc-a', 'svc-b']);
    const again = await counted(() => fresh.getTrace(T1));
    expect(again.arrow).toBe(0);
    expect(again.value).toBe(open.value);
  });

  test('serviceShare takes a signal: an aborted load rejects with AbortError', async () => {
    const ctl = new AbortController();
    const p = ds.serviceShare(T3, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('getTrace is memoised for the last id, hasTrace is a bound method', async () => {
    const a = ds.getTrace(T1);
    expect(ds.getTrace(T1)).toBe(a);
    expect(ds.getTrace(T3)).not.toBe(a);
    const { hasTrace } = ds;
    expect(await hasTrace(T1)).toBe(true);
    expect(await hasTrace(parseTraceId(hex(99, 32), 'test'))).toBe(false);
    await expect(ds.getTrace(parseTraceId(hex(99, 32), 'test'))).rejects.toMatchObject({ code: 'usage' });
  });

  test('the metric methods answer from points', async () => {
    expect(await ds.metricCatalog()).toMatchObject({ entries: [], resources: [], scopes: [] });
    expect(await ds.metricsForResources([])).toEqual([]);
  });

  test('manifest and epoch are the report’s', () => {
    expect(ds.manifest).toBe(f.manifest);
    expect(ds.epoch).toBe(f.epoch);
  });
});

describe('helpers', () => {
  test('toNumber throws invalid-report on a bigint outside the safe range', () => {
    expect(toNumber(5n, 'x')).toBe(5);
    expect(toNumber(-5, 'x')).toBe(-5);
    expect(() => toNumber(2n ** 60n, 'x')).toThrow(OtelHtmlError);
    try {
      toNumber(2n ** 60n, 'x');
    } catch (e) {
      expect((e as OtelHtmlError).code).toBe('invalid-report');
    }
    expect(() => toNumber('7', 'x')).toThrow(OtelHtmlError);
  });

  test('residualRows pages until limit survivors, at most eight pages', async () => {
    const calls: number[] = [];
    const data = Array.from({ length: 100 }, (_, i) => i);
    const fetch = async (limit: number, offset: number): Promise<number[]> => {
      calls.push(offset);
      return data.slice(offset, offset + limit);
    };
    const some = await residualRows({ fetch, test: (n) => n % 5 === 0, limit: 4 });
    expect(some).toEqual({ rows: [0, 5, 10, 15], exhausted: false });
    expect(calls).toEqual([0, 4, 8, 12, 16, 20]);
    calls.length = 0;
    const none = await residualRows({ fetch, test: () => false, limit: 4 });
    expect(none).toEqual({ rows: [], exhausted: false });
    expect(calls).toHaveLength(8);
    const end = await residualRows({ fetch, test: (n) => n >= 98, limit: 50 });
    expect(end).toEqual({ rows: [98, 99], exhausted: true });
  });
});

describe('residual cleanup', () => {
  const leftovers = (): unknown[] =>
    db.rows("SELECT table_name FROM duckdb_tables() WHERE table_name LIKE 'otel_residual%'");

  /** The real engine with hooks: `query` and `exec` see the call number first; `texts` records every registered text. */
  function hooked(hooks: {
    query?: (n: number, run: () => ReturnType<QueryEngine['query']>) => ReturnType<QueryEngine['query']>;
    exec?: (sql: string, run: () => Promise<void>) => Promise<void>;
  }) {
    const base = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
    const texts = new Map<string, string>();
    let n = 0;
    const engine: QueryEngine = {
      ...base,
      query: (q, signal) => {
        n += 1;
        const run = () => base.query(q, signal);
        return hooks.query === undefined ? run() : hooks.query(n, run);
      },
      exec: (sql) => {
        const run = () => base.exec(sql);
        return hooks.exec === undefined ? run() : hooks.exec(sql, run);
      },
      registerText: async (name, text) => {
        texts.set(name, text);
        await base.registerText(name, text);
      },
    };
    const warnings: string[] = [];
    const source = createDuckDbDataSource({
      engine,
      manifest: f.manifest,
      logger: { warn: (m: string) => void warnings.push(m) },
    });
    return { source, texts, warnings };
  }
  const residualQuery = (text: string): SpanQuery =>
    query({ condition: 'Len(name) > 7', needs: [...ALL], text });

  test('a query failing after the id table exists rejects and leaves no table or text', async () => {
    const h = hooked({ query: (n, run) => (n >= 2 ? Promise.reject(new Error('boom')) : run()) });
    await expect(h.source.querySpans(residualQuery(''))).rejects.toThrow();
    expect(leftovers()).toEqual([]);
    expect([...h.texts.values()]).toEqual(['']);
  });

  test('an abort after the id table exists rejects with AbortError and leaves no table or text', async () => {
    const ctl = new AbortController();
    const h = hooked({
      query: (n, run) => {
        if (n === 2) ctl.abort();
        return run();
      },
    });
    await expect(h.source.querySpans(residualQuery(''), ctl.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(leftovers()).toEqual([]);
    expect([...h.texts.values()]).toEqual(['']);
  });

  test('a failing CREATE empties the registered text', async () => {
    const h = hooked({
      exec: (sql, run) => (sql.startsWith('CREATE') ? Promise.reject(new Error('no create')) : run()),
    });
    await expect(h.source.querySpans(residualQuery(''))).rejects.toThrow();
    expect(leftovers()).toEqual([]);
    expect([...h.texts.values()]).toEqual(['']);
  });

  test('a failing DROP still empties the text, is logged, and does not fail the query', async () => {
    const h = hooked({
      exec: (sql, run) => (sql.startsWith('DROP') ? Promise.reject(new Error('no drop')) : run()),
    });
    const r = await h.source.querySpans(residualQuery(''));
    expect(r.total).toBe(3);
    expect([...h.texts.values()]).toEqual(['']);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/otel_residual_\d+/);
    db.exec(`DROP TABLE IF EXISTS ${/otel_residual_\d+/.exec(h.warnings[0] ?? '')?.[0]}`);
    expect(leftovers()).toEqual([]);
  });

  test('over the page budget, total is the candidate count, an upper bound', async () => {
    const r = await ds.querySpans(query({ condition: 'Len(name) > 7', needs: ['rows'], limit: 1 }));
    expect(spanRows(r.rows)).toHaveLength(1);
    expect(r.total).toBe(6); // 3 spans match; the 6 candidates are all that is known
  });
});

describe('facet caps from the manifest', () => {
  const many: S[] = [1, 2, 3, 4].map((i) => ({
    trace: i,
    id: i,
    svc: 'svc-a',
    name: 'op',
    startMs: i,
    durMs: 1,
    attrs: [attr(`key.${i}`, str('v'))],
  }));
  const attrKeys = async (source: DataSource): Promise<string[]> => {
    const r = await source.querySpans(query({ needs: ['facets'] }));
    return r.facets.keys().filter((k) => k.startsWith('key.'));
  };

  test('a report written with facetKeyCap 2 shows at most 2 attribute keys', async () => {
    const capped = await buildFormat4Report([request(many)], { config: { writer: { facetKeyCap: 2 } } });
    expect(capped.manifest.config.viewer.facetKeyCap).toBe(2);
    const cdb = await openFixtureDb(capped);
    const source = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(cdb.connector, silentLogger), cdb),
      manifest: capped.manifest,
    });
    expect((await attrKeys(source)).length).toBe(2);
  });

  test('a manifest without the caps uses the defaults', async () => {
    const plain = await buildFormat4Report([request(many)]);
    const { facetValueCap: _v, facetKeyCap: _k, ...viewer } = plain.manifest.config.viewer;
    const manifest = { ...plain.manifest, config: { ...plain.manifest.config, viewer } };
    const pdb = await openFixtureDb(plain);
    const source = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(pdb.connector, silentLogger), pdb),
      manifest,
    });
    expect((await attrKeys(source)).length).toBe(4);
  });
});

describe('getTrace: a provisional CI span and its final copy (§5.5)', () => {
  test('spans and tree hold the final row only', async () => {
    const T4 = parseTraceId(hex(4, 32), 'test');
    const provisional: S = {
      trace: 4,
      id: 9,
      svc: 'ci',
      name: 'job',
      startMs: 0,
      durMs: 10,
      attrs: [attr('otel_html.ci.provisional', { boolValue: true })],
    };
    const final: S = { trace: 4, id: 9, svc: 'ci', name: 'job', startMs: 0, durMs: 50 };
    // The writer's own dedupe would drop the second copy, so the two reports are joined by hand: the final
    // report's partition is renumbered and appended to the provisional one's manifest.
    const first = await buildFormat4Report([request([provisional])], { close: false });
    const second = await buildFormat4Report([request([final])], { close: false });
    const moved = JSON.parse(
      JSON.stringify(second.manifest.partitions[0], (_k, v: unknown) =>
        typeof v === 'string' ? v.replace('data/partitions/000000/', 'data/partitions/000001/') : v,
      ),
    ) as Format4Fixture['manifest']['partitions'][number];
    const files = new Map(first.files);
    for (const [path, bytes] of second.files) files.set(path.replace('000000', '000001'), bytes);
    const fx: Format4Fixture = {
      ...first,
      manifest: { ...first.manifest, partitions: [...first.manifest.partitions, moved] },
      files,
    };
    const fdb = await openFixtureDb(fx);
    const source = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(fdb.connector, silentLogger), fdb),
      manifest: fx.manifest,
    });
    const detail = await source.getTrace(T4);
    expect(detail.spans).toHaveLength(1);
    expect(detail.spans[0]?.durationNs).toBe(50e6);
    expect(detail.tree.roots).toHaveLength(1);
    expect(detail.tree.roots[0]?.row).toBe(detail.spans[0]);
  });
});

describe('preparing the files a statement reads', () => {
  const pathsOf = (table: 'spans' | 'logs' | 'traces' | 'points'): string[] =>
    f.manifest.partitions.flatMap((p) => {
      const file = p.files[table];
      return file === undefined ? [] : [file.path];
    });

  function recording(gate?: Promise<void>) {
    const inner = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
    const events: ({ kind: 'prepare'; paths: readonly string[] } | { kind: 'query' })[] = [];
    const engine: QueryEngine = {
      ...inner,
      prepare: async (paths, signal) => {
        events.push({ kind: 'prepare', paths });
        await gate;
        await inner.prepare(paths, signal);
      },
      query: (q, signal) => {
        events.push({ kind: 'query' });
        return inner.query(q, signal);
      },
    };
    return { events, source: createDuckDbDataSource({ engine, manifest: f.manifest }) };
  }

  test('a trace list prepares the spans files of the pruned partitions and every traces file', async () => {
    const { events, source } = recording();
    // 5 ms keeps the first spans partition only (timeMin of the others is later)
    await source.querySpans(
      query({ mode: 'traces', needs: ['rows'], window: { start: -1e9, end: 5e6 }, text: 'no-cache-1' }),
    );
    const prepared = events.flatMap((e) => (e.kind === 'prepare' ? e.paths : []));
    expect(new Set(prepared)).toEqual(new Set([pathsOf('spans')[0], ...pathsOf('traces')]));
    expect(prepared.filter((p) => pathsOf('spans').includes(p))).toEqual([pathsOf('spans')[0]]);
    expect(prepared.some((p) => pathsOf('logs').includes(p))).toBe(false);
  });

  test('values outside the window are not listed and their partitions are not read', async () => {
    const { events, source } = recording();
    // 1 to 5 ms: only the first spans partition holds a span that starts that early, and the logs are all at 0
    expect(await source.resourceValues('service.name', { window: { start: 1e6, end: 5e6 } })).toEqual({
      values: ['svc-a'],
      kind: 'string',
      capped: false,
    });
    const prepared = events.flatMap((e) => (e.kind === 'prepare' ? e.paths : []));
    expect(prepared.filter((p) => pathsOf('spans').includes(p))).toEqual([pathsOf('spans')[0]]);
    expect(prepared.some((p) => pathsOf('logs').includes(p))).toBe(false);
    expect(prepared.some((p) => pathsOf('points').includes(p))).toBe(false);
    expect((await source.resourceValues('service.name', { window: null })).values).toEqual([
      'svc-a',
      'svc-b',
    ]);
  });

  test('no statement runs before its prepare resolved', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { events, source } = recording(gate);
    const pending = source.querySpans(query({ needs: ['rows'], text: 'no-cache-2' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => e.kind)).toEqual(['prepare']);
    release();
    await pending;
    expect(events.map((e) => e.kind)).toEqual(['prepare', 'query']);
  });
});

describe('getTrace and serviceShare with a span that ends before it starts', () => {
  const T4 = parseTraceId(hex(4, 32), 'test');
  const T5 = parseTraceId(hex(5, 32), 'test');
  let g: Format4Fixture;
  let gdb: TestDb;
  const fresh = () =>
    createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(gdb.connector, silentLogger), gdb),
      manifest: g.manifest,
    });
  const arrows = async <T>(fn: () => Promise<T>): Promise<{ value: T; arrow: number }> => {
    const before = gdb.connector.requests.length;
    const value = await fn();
    return {
      value,
      arrow: gdb.connector.requests.slice(before).filter((r) => r.type === 'arrow').length,
    };
  };

  beforeAll(async () => {
    g = await buildFormat4Report(
      [
        request([
          // a single span whose end is before its start
          { trace: 4, id: 1, svc: 'svc-a', name: 'solo', startMs: 5000, durMs: -100 },
          // the latest-starting span of a longer trace ends before it starts, outside [min start, max end]
          { trace: 5, id: 20, svc: 'svc-a', name: 'root', startMs: 2000, durMs: 50 },
          { trace: 5, id: 21, parent: 20, svc: 'svc-b', name: 'late', startMs: 2100, durMs: -2200 },
          // a normal trace
          { trace: 1, id: 30, svc: 'svc-a', name: 'ok', startMs: 0, durMs: 10 },
        ]),
      ],
      { close: false },
    );
    gdb = await openFixtureDb(g);
  });

  test('a single-span trace with end before start opens with its span', async () => {
    const detail = await fresh().getTrace(T4);
    expect(detail.spans.map((s) => s.span.name)).toEqual(['solo']);
  });

  test('a multi-span trace keeps the span that lies outside the bound, for getTrace and serviceShare', async () => {
    const detail = await fresh().getTrace(T5);
    expect(detail.spans.map((s) => s.span.name)).toEqual(['root', 'late']);
    expect((await fresh().serviceShare(T5)).map((x) => x.service).sort()).toEqual(['svc-a', 'svc-b']);
  });

  test('a normal trace does not read again: partitions, spans and summary, three statements', async () => {
    const open = await arrows(() => fresh().getTrace(T1));
    expect(open.arrow).toBe(3);
    const share = await arrows(() => fresh().serviceShare(T1));
    expect(share.arrow).toBe(2);
    // the malformed trace pays one more
    expect((await arrows(() => fresh().getTrace(T5))).arrow).toBe(4);
    expect((await arrows(() => fresh().serviceShare(T5))).arrow).toBe(3);
  });
});

describe('long windows count spans by start time', () => {
  const LONG = 16_777_216_000_000;
  // a window made long at 60 s; its aligned edges are where the fixture puts its spans
  const asked = { start: 60_000e6, end: 60_000e6 + LONG };
  const edge = alignLongWindow(asked, BASE);
  const ms = (rel: number): number => rel / 1e6;
  const SPANS: S[] = [
    { trace: 1, id: 1, svc: 'svc-a', name: 'at-start', startMs: ms(edge.start), durMs: 10 },
    { trace: 2, id: 2, svc: 'svc-a', name: 'at-end', startMs: ms(edge.end), durMs: 10 },
    // the earliest span sets the report's epoch (BASE), which the edges above were computed against
    { trace: 3, id: 3, svc: 'svc-a', name: 'overlap-only', startMs: 0, durMs: ms(edge.start) + 2000 },
    { trace: 4, id: 4, svc: 'svc-a', name: 'inside', startMs: ms(edge.start) + 1000, durMs: 10 },
  ];
  let lds: DataSource;
  let ldb: TestDb;

  beforeAll(async () => {
    const rep = await buildFormat4Report([request(SPANS)], { close: false });
    ldb = await openFixtureDb(rep);
    lds = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(ldb.connector, silentLogger), ldb),
      manifest: rep.manifest,
    });
  });

  const names = async (window: { start: number; end: number }): Promise<string[]> =>
    spanRows((await lds.querySpans(query({ window, needs: ['rows'] }))).rows)
      .map((r) => r.span.name)
      .sort();

  test('long: a span starting exactly on the end is out, one starting on the start is in, one that only overlaps is out', async () => {
    expect(await names(asked)).toEqual(['at-start', 'inside']);
    expect(await names(edge)).toEqual(['at-start', 'inside']);
  });

  test('short: overlap and inclusive ends, as today', async () => {
    const short = { start: edge.end - 1000e6, end: edge.end };
    expect(await names(short)).toEqual(['at-end']);
    expect(await names({ start: edge.start, end: edge.start + 100e6 })).toEqual(['at-start', 'overlap-only']);
  });
});

describe('long windows list a trace in the window its earliest span starts in', () => {
  const LONG = 16_777_216_000_000;
  const asked = { start: 60_000e6, end: 60_000e6 + LONG };
  const edge = alignLongWindow(asked, BASE);
  const ms = (rel: number): number => rel / 1e6;
  const inside = (extraMs: number): number => ms(edge.start) + extraMs;
  // trace 1 starts at 0 (the epoch) in partition 0 and continues in partition 1, inside the window
  const PART0: S[] = [
    { trace: 1, id: 1, svc: 'svc-a', name: 'early', startMs: 0, durMs: 10 },
    { trace: 2, id: 2, svc: 'svc-a', name: 'two', startMs: inside(1000), durMs: 10 },
  ];
  const PART1: S[] = [
    { trace: 1, id: 3, parent: 1, svc: 'svc-a', name: 'late', startMs: inside(2000), durMs: 10 },
    { trace: 3, id: 4, svc: 'svc-a', name: 'three', startMs: inside(3000), durMs: 10 },
  ];
  const PART2: S[] = [
    { trace: 4, id: 5, svc: 'svc-a', name: 'after', startMs: ms(edge.end) + 1000, durMs: 10 },
    { trace: 3, id: 6, parent: 4, svc: 'svc-a', name: 'three-late', startMs: ms(edge.end) + 2000, durMs: 10 },
  ];
  let rep: Format4Fixture;
  let tdb: TestDb;
  const listed = (r: Awaited<ReturnType<DataSource['querySpans']>>): string[] =>
    traceRows(r.rows).map((t) => t.traceId.slice(-2));
  const tq = (over: Partial<SpanQuery> = {}): SpanQuery =>
    query({ mode: 'traces', needs: ['rows', 'total'], window: asked, ...over });

  beforeAll(async () => {
    rep = await buildFormat4Report([request(PART0), request(PART1), request(PART2)], { close: false });
    tdb = await openFixtureDb(rep);
  });

  function recording() {
    const inner = mosaicQueryEngine(createCoordinator(tdb.connector, silentLogger), tdb);
    const prepared: string[] = [];
    const sql: string[] = [];
    const engine: QueryEngine = {
      ...inner,
      prepare: (paths, signal) => {
        prepared.push(...paths);
        return inner.prepare(paths, signal);
      },
      query: (q, signal) => {
        sql.push(String(q));
        return inner.query(q, signal);
      },
    };
    return { prepared, sql, source: createDuckDbDataSource({ engine, manifest: rep.manifest }) };
  }
  const pathsOf = (table: 'spans' | 'traces'): string[] =>
    rep.manifest.partitions.flatMap((p) => (p.files[table] === undefined ? [] : [p.files[table].path]));

  test('long window: a trace split over two partitions that starts before the window is not listed, though one partition’s row starts inside', async () => {
    for (const over of [{}, { condition: 'name == "late"' }, { text: 'late' }]) {
      const r = await recording().source.querySpans(tq(over));
      expect(listed(r), JSON.stringify(over)).not.toContain('01');
    }
    const r = await recording().source.querySpans(tq());
    expect(listed(r)).toEqual(['02', '03']);
    expect(r.total).toBe(2);
  });

  test('long window: a trace is whole, with the spans it has after the window', async () => {
    for (const over of [{}, { condition: 'name == "three"' }]) {
      const r = await recording().source.querySpans(tq(over));
      expect(traceRows(r.rows).find((t) => t.traceId.endsWith('03'))?.spans, JSON.stringify(over)).toBe(2);
    }
    // a matching span after the window still lists the trace that starts in it
    const late = await recording().source.querySpans(tq({ condition: 'name == "three-late"' }));
    expect(listed(late)).toEqual(['03']);
  });

  test('long window: a condition that is always true lists the same traces, in the same order, as no condition', async () => {
    for (const sort of ['start', 'duration', 'spans'] as const) {
      const sorted = { sort: { column: sort, dir: 'desc' as const } };
      const all = await recording().source.querySpans(tq(sorted));
      const cond = await recording().source.querySpans(tq({ ...sorted, condition: 'name != "no-such"' }));
      expect(cond.rows).toEqual(all.rows);
      expect(cond.total).toBe(all.total);
    }
  });

  test('long window: an unconditioned list and its count run no statement over spans', async () => {
    const list = recording();
    await list.source.querySpans(tq());
    expect(list.sql.filter((q) => /\bspans\b/.test(q))).toEqual([]);
    const count = recording();
    const r = await count.source.querySpans(tq({ needs: ['total'], mode: 'traces' }));
    expect(r.total).toBe(2);
    expect(count.sql.filter((q) => /\bspans\b/.test(q))).toEqual([]);
  });

  test('long window: a conditioned list reads spans only in the partitions the traces rows name', async () => {
    const { prepared, source } = recording();
    // trace 2 starts in partition 0 and has no other row
    const r = await source.querySpans(tq({ condition: 'name == "two"' }));
    expect(listed(r)).toEqual(['02']);
    expect(prepared.filter((p) => pathsOf('spans').includes(p))).toEqual([pathsOf('spans')[0]]);
    expect(new Set(prepared.filter((p) => pathsOf('traces').includes(p)))).toEqual(
      new Set(pathsOf('traces')),
    );
  });

  test('long window: a residual condition finds the traces the SQL-only one finds, a span after the window included', async () => {
    // Len(name) is evaluated in the browser; "three-late" starts after the window and is the only match
    const sqlOnly = await recording().source.querySpans(tq({ condition: 'name == "three-late"' }));
    const residual = await recording().source.querySpans(tq({ condition: 'Len(name) == 10' }));
    expect(listed(sqlOnly)).toEqual(['03']);
    expect(listed(residual)).toEqual(['03']);
    expect(residual.total).toBe(sqlOnly.total);
    const all = await recording().source.querySpans(tq());
    const always = await recording().source.querySpans(tq({ condition: 'Len(name) > -1' }));
    expect(always.rows).toEqual(all.rows);
    expect(always.total).toBe(all.total);
  });

  test('long window: the total alone counts traces by their start, whatever the condition', async () => {
    const total = async (over: Partial<SpanQuery>): Promise<number> =>
      (await recording().source.querySpans(tq({ needs: ['total'], ...over }))).total;
    expect(await total({})).toBe(2);
    expect(await total({ condition: 'name == "three-late"' })).toBe(1);
    expect(await total({ condition: 'name == "late"' })).toBe(0);
    expect(await total({ condition: 'Len(name) == 10' })).toBe(1);
    expect(await total({ condition: 'name != "no-such"' })).toBe(2);
  });

  test('short window: the list is by overlap, as today', async () => {
    const r = await recording().source.querySpans(
      query({ mode: 'traces', needs: ['rows', 'total'], window: { start: 0, end: 1e9 } }),
    );
    expect(listed(r)).toEqual(['01']);
  });
});
