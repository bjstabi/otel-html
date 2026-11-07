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

  test('getTrace is memoised for the last id, hasTrace is a bound method', async () => {
    const a = ds.getTrace(T1);
    expect(ds.getTrace(T1)).toBe(a);
    expect(ds.getTrace(T3)).not.toBe(a);
    const { hasTrace } = ds;
    expect(await hasTrace(T1)).toBe(true);
    expect(await hasTrace(parseTraceId(hex(99, 32), 'test'))).toBe(false);
    await expect(ds.getTrace(parseTraceId(hex(99, 32), 'test'))).rejects.toMatchObject({ code: 'usage' });
  });

  test('metrics reject with a usage error naming plan 3', async () => {
    for (const p of [ds.metricCatalog(), ds.metric(1), ds.metricsForResources([])]) {
      await expect(p).rejects.toSatisfy(
        (e: unknown) => e instanceof OtelHtmlError && e.code === 'usage' && /plan 3/.test(e.message),
      );
    }
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
