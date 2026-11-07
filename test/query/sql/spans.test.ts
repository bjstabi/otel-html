import { beforeAll, describe, expect, test } from 'vitest';
import type { ManifestV4 } from '../../../src/format/manifest.js';
import { parseTraceId } from '../../../src/model/ids.js';
import { toSql } from '../../../src/query/sql/columns.js';
import {
  attributeFacetsQuery,
  CORE_LOG_FACETS,
  CORE_SPAN_FACETS,
  coreFacetsQuery,
} from '../../../src/query/sql/facets.js';
import { buildFilter, whereOf } from '../../../src/query/sql/filter.js';
import { absWindow } from '../../../src/query/sql/prune.js';
import {
  durationBinsQuery,
  durationSummaryQuery,
  groupStatsQuery,
  percentileQuery,
  resourceValuesQuery,
  serviceBucketsQuery,
  servicesQuery,
  spanRowsQuery,
  timelineQuery,
  tracePartitionsQuery,
  traceRowsQuery,
  traceSpansQuery,
  traceSummaryQuery,
} from '../../../src/query/sql/spans.js';
import { bucketSpec } from '../../../src/query/sql/time.js';
import type { TestDb } from '../../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../../test-support/format4-fixture.js';
import {
  attr,
  type JsonObject,
  logRecord,
  logsRequest,
  span,
  traceRequest,
} from '../../../test-support/otlp-builders.js';
import { EPOCH_NS, otlp } from '../../../test-support/writer-deps.js';

type RowKey =
  | 'key'
  | 'value'
  | 'kind'
  | 'n'
  | 'total'
  | 'errors'
  | 'bucket'
  | 'bin'
  | 'percentile'
  | 'service_name'
  | 'quantiles'
  | 'max_duration_ns'
  | 'span_count'
  | 'start_ns'
  | 'filename'
  | 'trace_id';
type Row = Partial<Record<RowKey, unknown>> & Record<string, unknown>;

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

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
const BASE = BigInt(EPOCH_NS);
const ns = (ms: number): bigint => BigInt(Math.round(ms * 1e6));
const str = (v: string): JsonObject => ({ stringValue: v });

function request(spans: S[]): ReturnType<typeof otlp> {
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
          endTimeUnixNano: String(BASE + ns(s.startMs + s.durMs)),
          ...(s.error === true ? { status: { code: 2 } } : {}),
          attributes: s.attrs ?? [],
        }),
      );
    const r = traceRequest(mine, [attr('service.name', str(svc)), attr('host.name', str('host-1'))]) as {
      resourceSpans: unknown[];
    };
    resourceSpans.push(...r.resourceSpans);
  }
  return otlp({ resourceSpans } as never);
}

const http = (method: string, route: string): JsonObject[] => [
  attr('http.request.method', str(method)),
  attr('http.route', str(route)),
];

// Partition 0 holds T1 (root, two children, one error) and T2 (one error root); partition 1 holds the rest of T1, and T3.
const P0: S[] = [
  { trace: 1, id: 1, svc: 'svc-a', name: 'GET /users', startMs: 0, durMs: 100, attrs: http('GET', '/users') },
  {
    trace: 1,
    id: 2,
    parent: 1,
    svc: 'svc-b',
    name: 'SELECT',
    startMs: 10,
    durMs: 50,
    attrs: [attr('k.mixed', { intValue: '7' }), attr('k.s', str('x'))],
  },
  {
    trace: 1,
    id: 3,
    parent: 1,
    svc: 'svc-b',
    name: 'SELECT',
    startMs: 20,
    durMs: 5,
    error: true,
    attrs: [attr('k.mixed', str('seven'))],
  },
  {
    trace: 2,
    id: 4,
    svc: 'svc-a',
    name: 'POST /orders',
    startMs: 200,
    durMs: 300,
    error: true,
    attrs: [
      ...http('POST', '/orders'),
      attr('k.b', { boolValue: true }),
      attr('$weird', str('w')),
      attr('k.s', str('y')),
    ],
  },
];
const P1: S[] = [
  {
    trace: 1,
    id: 5,
    parent: 2,
    svc: 'svc-b',
    name: 'COMMIT',
    startMs: 60,
    durMs: 20,
    attrs: [attr('k.d', { doubleValue: 1.5 })],
  },
  {
    trace: 3,
    id: 6,
    svc: 'svc-a',
    name: 'GET /users',
    startMs: 1000,
    durMs: 10,
    attrs: http('GET', '/users'),
  },
  { trace: 3, id: 7, parent: 6, svc: 'svc-b', name: 'SELECT', startMs: 1002, durMs: 2 },
];
const T1 = parseTraceId(hex(1, 32), 'test');

let f: Format4Fixture;
let db: TestDb;

beforeAll(async () => {
  f = await buildFormat4Report([request(P0), request(P1)], { close: false });
  db = await openFixtureDb(f);
});

const rel = (ms: number): number => Number(BASE + ns(ms) - f.epoch);
const relBig = (ms: number): bigint => BASE + ns(ms) - f.epoch;
const run = (q: { toString(): string }): Row[] => db.rows(q.toString());
const col = (rows: Row[], name: string): unknown[] => rows.map((r) => r[name]);

function filter(
  over: {
    condition?: string | null;
    text?: string;
    window?: { start: number; end: number } | null;
    manifest?: ManifestV4;
  } = {},
) {
  return buildFilter({
    manifest: over.manifest ?? f.manifest,
    table: 'spans',
    condition: over.condition ?? null,
    text: over.text ?? '',
    window: over.window ?? null,
  });
}

describe('time buckets', () => {
  test('bucketSpec picks the smallest 1 ms * 2^k width that fits 4096 buckets', () => {
    expect(bucketSpec({ start: 0, end: 4095e6 }, null).widthNs).toBe(1e6);
    expect(bucketSpec({ start: 0, end: 4096e6 }, null).widthNs).toBe(2e6);
  });
  test('bucketSpec aligns to the width, falls back to the range and survives no range', () => {
    expect(bucketSpec({ start: -1.5e6, end: 7.2e6 }, null)).toEqual({
      widthNs: 1e6,
      startNs: -2e6,
      endNs: 7e6,
    });
    expect(bucketSpec(null, { start: 3e6, end: 9e6 })).toMatchObject({ startNs: 3e6, endNs: 9e6 });
    expect(bucketSpec(null, null).widthNs).toBe(1e6);
  });
});

describe('buildFilter and whereOf', () => {
  test('a window prunes the spans files that start after it; a condition hint prunes by statistics', () => {
    expect(filter().filter.files.all).toBe(true);
    const early = filter({ window: { start: 0, end: rel(30) } }).filter;
    expect(early.files.files).toHaveLength(1);
    expect(early.files.all).toBe(false);
    expect(
      whereOf(early, 'spans')
        .map((e) => toSql(e))
        .join(' '),
    ).toContain('filename');
  });
  test('the spans window keeps a span that starts before it and ends inside', () => {
    const { filter: w } = filter({ window: { start: rel(90), end: rel(150) } });
    const rows = run(spanRowsQuery(w, { column: 'start', dir: 'asc' }, 10));
    expect(col(rows, 'name')).toEqual(['GET /users']);
  });
  test('traceId pruning keeps the partitions the caller names', () => {
    const traceFiles = run(tracePartitionsQuery(T1)).map((r) => String(r.filename));
    expect(traceFiles).toHaveLength(2);
    const one = buildFilter({
      manifest: f.manifest,
      table: 'spans',
      condition: null,
      text: '',
      window: null,
      traceId: T1,
      traceFiles: [traceFiles[0] as string],
    });
    expect(one.filter.files.files).toHaveLength(1);
  });
  test('a user value never reaches the SQL text unescaped', () => {
    const { filter: w } = filter({ condition: `name == "a'b"`, text: `q'; DROP VIEW spans; --` });
    expect(run(spanRowsQuery(w, { column: 'start', dir: 'asc' }, 10))).toEqual([]);
    expect(Number(run({ toString: () => 'SELECT count(*) AS n FROM spans' })[0]?.n)).toBe(7);
  });
  test('a residual condition is returned for the browser', () => {
    expect(filter({ condition: 'Len(name) > 3' }).residual).toBe('Len(name) > 3');
    expect(filter({ condition: 'name == "x"' }).residual).toBeNull();
  });
  test('whereOf logs uses coalesce(time, observed)', () => {
    const w = buildFilter({
      manifest: f.manifest,
      table: 'logs',
      condition: null,
      text: '',
      window: { start: 0, end: 10 },
    });
    expect(w.filter.files.files).toEqual([]);
    expect(whereOf(w.filter, 'logs').map(toSql).join(' ')).toContain('coalesce');
  });
});

describe('span rows', () => {
  test('spanRowsQuery sorts by duration desc with the start/span_id tiebreak and carries total', () => {
    const { filter: w } = filter();
    const rows = run(spanRowsQuery(w, { column: 'duration', dir: 'desc' }, 100));
    expect(col(rows, 'duration_ns')).toEqual([300, 100, 50, 20, 10, 5, 2].map((ms) => ns(ms)));
    expect(new Set(col(rows, 'total'))).toEqual(new Set([7n]));
    expect(rows[0]).toMatchObject({ name: 'POST /orders', start_ns: relBig(200), end_ns: relBig(500) });
    expect(rows[0]).toHaveProperty('filename');
    expect(rows[0]).toHaveProperty('file_row_number');
  });
  test('ties on the sort column fall back to start then span_id; limit leaves total whole', () => {
    const { filter: w } = filter();
    const rows = run(spanRowsQuery(w, { column: 'name', dir: 'asc' }, 4));
    expect(col(rows, 'name')).toEqual(['COMMIT', 'GET /users', 'GET /users', 'POST /orders']);
    expect(col(rows, 'start_ns')).toEqual([relBig(60), relBig(0), relBig(1000), relBig(200)]);
    expect(rows.every((r) => r.total === 7n)).toBe(true);
  });
  test('service, resource and status sort', () => {
    const { filter: w } = filter();
    expect(col(run(spanRowsQuery(w, { column: 'service', dir: 'desc' }, 1)), 'service_name')).toEqual([
      'svc-b',
    ]);
    expect(col(run(spanRowsQuery(w, { column: 'resource', dir: 'asc' }, 1)), 'resource_name')).toEqual([
      'COMMIT',
    ]);
    expect(col(run(spanRowsQuery(w, { column: 'status', dir: 'desc' }, 2)), 'status_code')).toEqual([2, 2]);
  });
});

describe('trace rows', () => {
  test('traceRowsQuery aggregates a trace split across partitions into one row with summed counts', () => {
    const { filter: w } = filter();
    const rows = run(traceRowsQuery(w, { column: 'start', dir: 'asc' }, 10));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      trace_id: hex(1, 32),
      span_count: 4n,
      error_count: 1n,
      start_ns: relBig(0),
      end_ns: relBig(100),
      duration_ns: ns(100),
      root_service: 'svc-a',
      root_name: 'GET /users',
      root_resource: 'GET /users',
      total: 3n,
    });
  });
  test('sort, condition and limit', () => {
    const { filter: all } = filter();
    expect(col(run(traceRowsQuery(all, { column: 'duration', dir: 'desc' }, 1)), 'trace_id')).toEqual([
      hex(2, 32),
    ]);
    expect(col(run(traceRowsQuery(all, { column: 'errors', dir: 'desc' }, 10)), 'error_count')).toEqual([
      1n,
      1n,
      0n,
    ]);
    const { filter: one } = filter({ condition: 'name == "COMMIT"' });
    const rows = run(traceRowsQuery(one, { column: 'spans', dir: 'desc' }, 10));
    expect(col(rows, 'trace_id')).toEqual([hex(1, 32)]);
    expect(rows[0]?.span_count).toBe(4n);
    for (const column of ['service', 'resource'] as const)
      expect(run(traceRowsQuery(all, { column, dir: 'asc' }, 10))).toHaveLength(3);
  });
  test('tracePartitionsQuery, traceSpansQuery and traceSummaryQuery', () => {
    const files = run(tracePartitionsQuery(T1)).map((r) => String(r.filename));
    expect(files).toHaveLength(2);
    const spans = run(
      traceSpansQuery(
        T1,
        files.map((p) => p.replace('traces.parquet', 'spans.parquet')),
        f.epoch,
      ),
    );
    expect(col(spans, 'span_id')).toEqual([1, 2, 3, 5].map((n) => hex(n, 16)));
    expect(spans[1]?.start_ns).toBe(relBig(10));
    const [summary] = run(traceSummaryQuery(T1));
    expect(summary).toMatchObject({ span_count: 4n, partitions: 2n });
  });
});

describe('facets', () => {
  test('coreFacetsQuery counts every core facet in one statement and skips nulls', () => {
    const { filter: w } = filter();
    const rows = run(coreFacetsQuery(w, 'spans', CORE_SPAN_FACETS));
    const of = (key: string): Record<string, bigint> =>
      Object.fromEntries(rows.filter((r) => r.key === key).map((r) => [String(r.value), r.n as bigint]));
    expect(of('service.name')).toEqual({ 'svc-a': 3n, 'svc-b': 4n });
    expect(of('status.code')).toEqual({ error: 2n, unset: 5n });
    expect(of('span.kind')).toEqual({ internal: 7n });
    expect(of('span.name')).toMatchObject({ SELECT: 3n, 'GET /users': 2n });
    expect(of('resource')).toMatchObject({ 'GET /users': 2n, 'POST /orders': 1n });
    expect(of('host.name')).toEqual({ 'host-1': 7n });
    expect(of('deployment.environment.name')).toEqual({});
    expect(of('instrumentation_scope.name')).toEqual({ 'test-scope': 7n });
    expect(rows.every((r) => r.value !== null)).toBe(true);
  });
  test('log core facets: severity bands, trace presence, event name null for empty', async () => {
    const lf = await buildFormat4Report([
      otlp(
        logsRequest(
          [
            logRecord({ severityNumber: 9 }),
            logRecord({ severityNumber: 17, traceId: hex(1, 32), spanId: hex(1, 16), eventName: 'boom' }),
            logRecord({ severityNumber: 18 }),
          ],
          [attr('service.name', str('svc-a'))],
        ) as never,
      ),
    ]);
    const ldb = await openFixtureDb(lf);
    const w = buildFilter({ manifest: lf.manifest, table: 'logs', condition: null, text: '', window: null });
    const rows: Row[] = ldb.rows(coreFacetsQuery(w.filter, 'logs', CORE_LOG_FACETS).toString());
    const of = (key: string): Record<string, bigint> =>
      Object.fromEntries(rows.filter((r) => r.key === key).map((r) => [String(r.value), r.n as bigint]));
    expect(of('severity')).toEqual({ info: 1n, error: 2n });
    expect(of('trace.present')).toEqual({ yes: 1n, no: 2n });
    expect(of('event.name')).toEqual({ boom: 1n });
    expect(of('service.name')).toEqual({ 'svc-a': 3n });
  });
  test('attributeFacetsQuery keeps valueCap values per key, counts the rest in other, and reports mixed kinds', () => {
    const { filter: w } = filter();
    const rows = run(
      attributeFacetsQuery(w, 'spans', { facetValueCap: 1, facetKeyCap: 100 }, ['service.name']),
    );
    const forKey = (k: string): Row[] => rows.filter((r) => r.key === k);
    expect(forKey('k.s')).toEqual([{ key: 'k.s', kind: 'string', value: 'x', n: 1n, total: 2n }]);
    expect(forKey('k.mixed').map((r) => r.kind)).toEqual(['mixed']);
    expect(forKey('k.mixed')[0]?.total).toBe(2n);
    expect(forKey('k.d')[0]).toMatchObject({ kind: 'double', value: '1.5' });
    expect(forKey('k.b')[0]).toMatchObject({ kind: 'bool', value: 'true' });
    expect(new Set(col(rows, 'key'))).toEqual(
      new Set(['k.s', 'k.mixed', 'k.d', 'k.b', '$weird', 'http.request.method', 'http.route']),
    );
  });
  test('a record in the $m pairs form still lists its real keys', () => {
    const { filter: w } = filter({ text: 'weird' });
    const rows = run(attributeFacetsQuery(w, 'spans', { facetValueCap: 10, facetKeyCap: 100 }, []));
    expect(new Set(col(rows, 'key'))).toEqual(
      new Set(['$weird', 'k.s', 'k.b', 'http.request.method', 'http.route']),
    );
    expect(rows.find((r) => r.key === 'k.s')).toMatchObject({ value: 'y', kind: 'string' });
  });
  test('the key cap keeps the keys with the most values, ranked by count', () => {
    const { filter: w } = filter();
    const rows = run(attributeFacetsQuery(w, 'spans', { facetValueCap: 10, facetKeyCap: 1 }, []));
    expect(new Set(col(rows, 'key')).size).toBe(1);
  });
});

describe('timeline and durations', () => {
  test('timelineQuery buckets by the spec and clamps a span starting before the window to the first bucket', () => {
    const window = { start: rel(15), end: rel(70) };
    const { filter: w } = filter({ window });
    const spec = bucketSpec(window, null);
    const rows = run(timelineQuery(w, spec));
    expect(rows.map((r) => [r.bucket, r.n, r.errors])).toEqual([
      [relBig(15), 2n, 0n],
      [relBig(20), 1n, 1n],
      [relBig(60), 1n, 0n],
    ]);
    expect(rows[0]).toMatchObject({ ok: 0n, error: 0n, unset: 2n });
    expect(rows[0]?.max_duration_ns).toBe(ns(100));
    expect(Array.isArray(rows[0]?.quantiles) || typeof rows[0]?.quantiles === 'object').toBe(true);
  });
  test('durationSummaryQuery', () => {
    const { filter: w } = filter();
    expect(run(durationSummaryQuery(w))[0]).toMatchObject({
      n: 7n,
      min_duration_ns: ns(2),
      max_duration_ns: ns(300),
      sum_duration_ns: 487e6,
    });
  });
  test('durationBinsQuery counts exactly over the given axis, clamping below and above', () => {
    const { filter: w } = filter();
    const axis = [
      { fromNs: 3e6, toNs: 10e6 },
      { fromNs: 10e6, toNs: 100e6 },
      { fromNs: 100e6, toNs: 200e6 },
    ];
    const rows = run(durationBinsQuery(w, axis));
    expect(rows.map((r) => [r.bin, r.n])).toEqual([
      [0, 2n], // 2 ms clamps into the first bin with 5 ms
      [1, 3n],
      [2, 2n], // 300 ms clamps into the last
    ]);
    expect(run(durationBinsQuery(w, []))).toEqual([]);
  });
  test('groupStatsQuery groups by a core facet or an attribute, most frequent first, cap + 1 rows', () => {
    const { filter: w } = filter();
    const rows = run(groupStatsQuery(w, 'spans', 'span.name', 2));
    expect(col(rows, 'value')).toEqual(['SELECT', 'GET /users', 'COMMIT']);
    expect(rows[0]).toMatchObject({ n: 3n, errors: 1n, max_duration_ns: ns(50) });
    const attrs = run(groupStatsQuery(w, 'spans', 'k.s', 10));
    expect(col(attrs, 'value')).toEqual(['x', 'y']);
  });
});

describe('services', () => {
  test('percentileQuery is 100 at the maximum and 0 below the minimum', () => {
    const at = (d: number): Row | undefined => run(percentileQuery('svc-b', 'SELECT', d))[0];
    expect(at(50e6)).toMatchObject({ percentile: 100, n: 3n });
    expect(at(1e6)).toMatchObject({ percentile: 0, n: 3n });
    expect(Number(at(5e6)?.percentile)).toBeCloseTo(66.67, 1);
  });
  test('servicesQuery returns one row per service with quantiles; serviceBucketsQuery only the named services', () => {
    const { filter: w } = filter();
    const rows = run(servicesQuery(w, 10));
    expect(rows.map((r) => [r.service_name, r.n, r.errors])).toEqual([
      ['svc-b', 4n, 1n],
      ['svc-a', 3n, 1n],
    ]);
    expect(rows[0]).toHaveProperty('quantiles');
    expect(col(run(servicesQuery(w, 1)), 'service_name')).toEqual(['svc-b']);
    const spec = bucketSpec(null, { start: rel(0), end: rel(1010) });
    const buckets = run(serviceBucketsQuery(w, ['svc-a'], spec));
    expect(new Set(col(buckets, 'service_name'))).toEqual(new Set(['svc-a']));
    expect(buckets.reduce((a, r) => a + Number(r.n), 0)).toBe(3);
    expect(run(serviceBucketsQuery(w, [], spec))).toEqual([]);
  });
  test('resourceValuesQuery lists scalar resource attribute values and kinds, cap + 1 rows', () => {
    expect(run(resourceValuesQuery('host.name', 5))).toEqual([{ value: 'host-1', kind: 'string' }]);
    expect(col(run(resourceValuesQuery('service.name', 1)), 'value')).toHaveLength(2);
    expect(run(resourceValuesQuery('nope', 5))).toEqual([]);
  });
  test('absWindow is what the spans window compares against', () => {
    expect(absWindow({ start: 1, end: 2 }, f.epoch)).toEqual({ start: f.epoch + 1n, end: f.epoch + 2n });
  });
});
