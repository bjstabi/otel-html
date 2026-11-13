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
  allTraceRowsQuery,
  durationBinsQuery,
  durationSummaryQuery,
  groupStatsQuery,
  percentileQuery,
  resourceValuesQuery,
  serviceBucketsQuery,
  servicesQuery,
  spanCountQuery,
  spanRowsQuery,
  timelineQuery,
  traceBoundOf,
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
// The earliest span becomes the report epoch: starting it 123456 ns off a millisecond keeps the epoch unaligned to every bucket width.
const OFFSET = 123_456n;
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
          startTimeUnixNano: String(BASE + OFFSET + ns(s.startMs)),
          endTimeUnixNano: String(BASE + OFFSET + ns(s.startMs) + ns(s.durMs)),
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
    startMs: 19.999999,
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

const relBig = (ms: number): bigint => BASE + OFFSET + ns(ms) - f.epoch;
const rel = (ms: number): number => Number(relBig(ms));
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
  test('the fixture epoch is not aligned to a bucket width', () => {
    expect(f.epoch % 1_000_000n).toBe(123_456n);
  });
  test('bucketSpec picks the smallest 1 ms * 2^k width that fits 4096 buckets', () => {
    expect(bucketSpec({ start: 0, end: 4095e6 }, null).widthNs).toBe(1e6);
    expect(bucketSpec({ start: 0, end: 4096e6 }, null).widthNs).toBe(2e6);
  });
  test('bucketSpec aligns to the width, falls back to the range and survives no range', () => {
    expect(bucketSpec({ start: -1.5e6, end: 7.2e6 }, null)).toEqual({
      widthNs: 1e6,
      startNs: -2e6,
      endNs: 7e6,
      originNs: 0,
    });
    expect(bucketSpec(null, { start: 3e6, end: 9e6 })).toMatchObject({ startNs: 3e6, endNs: 9e6 });
    expect(bucketSpec(null, null).widthNs).toBe(1e6);
  });
  test('long: a 6 h window draws buckets of 65.536 s on absolute grain edges', () => {
    const epoch = 1_700_000_000_000_000_000n;
    const spec = bucketSpec({ start: 12_345e6, end: 12_345e6 + 6 * 3600e9 }, null, undefined, { epoch });
    expect(spec.widthNs).toBe(65_536_000_000);
    expect((epoch + BigInt(spec.startNs)) % 65_536_000_000n).toBe(0n);
    expect((epoch + BigInt(spec.endNs)) % 65_536_000_000n).toBe(0n);
    expect(BigInt(spec.originNs)).toBe((65_536_000_000n - (epoch % 65_536_000_000n)) % 65_536_000_000n);
    expect(spec.startNs).toBeLessThanOrEqual(12_345e6);
    expect(spec.endNs + spec.widthNs).toBeGreaterThan(12_345e6 + 6 * 3600e9);
    expect(bucketSpec({ start: 0, end: 6 * 3600e9 }, null).originNs).toBe(0);
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
    const rows = run(coreFacetsQuery(w, 'spans', CORE_SPAN_FACETS, { facetValueCap: 100 }));
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
    const rows: Row[] = ldb.rows(
      coreFacetsQuery(w.filter, 'logs', CORE_LOG_FACETS, { facetValueCap: 100 }).toString(),
    );
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
    expect(forKey('k.s')).toMatchObject([{ key: 'k.s', kind: 'string', value: 'x', n: 1n, total: 2n }]);
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
  test('spanCountQuery counts the filtered spans, or their traces', () => {
    const { filter: all } = filter();
    expect(run(spanCountQuery(all, 'spans'))).toEqual([{ total: 7n }]); // the fixture's span count, as durationSummaryQuery's n
    const traces = run(spanCountQuery(all, 'traces'))[0]?.total;
    expect(traces).toBe(
      BigInt(
        new Set(run(spanRowsQuery(all, { column: 'start', dir: 'asc' }, 100)).map((r) => r.trace_id)).size,
      ),
    );
  });
  test('timelineQuery buckets by the spec and clamps a span starting before the window to the first bucket', () => {
    const window = { start: rel(15), end: rel(70) };
    const { filter: w } = filter({ window });
    const spec = bucketSpec(window, null);
    const rows = run(timelineQuery(w, spec));
    expect(rows.map((r) => [r.bucket, r.n, r.errors])).toEqual([
      [15_000_000n, 2n, 0n],
      [19_000_000n, 1n, 1n], // 1 ns before the 20 ms boundary
      [60_000_000n, 1n, 0n],
    ]);
    expect(rows[0]).toMatchObject({ ok: 0n, error: 0n, unset: 2n });
    expect(rows[0]?.max_duration_ns).toBe(ns(100));
    expect(Array.isArray(rows[0]?.quantiles) || typeof rows[0]?.quantiles === 'object').toBe(true);
  });
  test('timelineQuery without latency gives the same counts and never reads duration_ns', () => {
    const window = { start: rel(15), end: rel(70) };
    const { filter: w } = filter({ window });
    const spec = bucketSpec(window, null);
    const q = timelineQuery(w, spec, false);
    expect(toSql(q)).not.toContain('duration_ns');
    const rows = run(q);
    expect(rows.map((r) => [r.bucket, r.n, r.errors])).toEqual([
      [15_000_000n, 2n, 0n],
      [19_000_000n, 1n, 1n],
      [60_000_000n, 1n, 0n],
    ]);
    expect(rows[0]).toMatchObject({ ok: 0n, error: 0n, unset: 2n });
    expect(Object.keys(rows[0] ?? {})).not.toContain('quantiles');
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
    const b = run(serviceBucketsQuery(w, ['svc-b'], bucketSpec(null, { start: rel(0), end: rel(1010) })));
    expect(col(b, 'bucket')).toEqual([10_000_000n, 19_000_000n, 60_000_000n, 1_002_000_000n]);
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
  test('resourceValuesQuery reads each resource text once and has no predicate a scan could take', () => {
    const text = toSql(resourceValuesQuery('host.name', 5));
    // The conditions live in aggregate FILTERs and a HAVING: a WHERE is pushed below the distinct, back onto every row.
    expect(text.replaceAll('FILTER (WHERE', '')).not.toMatch(/\bWHERE\b/);
    expect(text).toMatch(/\bHAVING\b/);
    for (const table of ['spans', 'logs', 'points'])
      expect(text.split(`SELECT "resource_attributes" FROM "${table}"`)).toHaveLength(2);
    expect(text.split('json_extract_string(').length).toBeLessThan(6); // extracted once over the union, not once per table
  });
  test('absWindow is what the spans window compares against', () => {
    expect(absWindow({ start: 1, end: 2 }, f.epoch)).toEqual({ start: f.epoch + 1n, end: f.epoch + 2n });
  });
});

describe('the unconditioned trace list', () => {
  const TRACE_SORTS = [
    { column: 'start', dir: 'asc' },
    { column: 'duration', dir: 'desc' },
    { column: 'spans', dir: 'desc' },
    { column: 'errors', dir: 'desc' },
    { column: 'service', dir: 'asc' },
    { column: 'resource', dir: 'asc' },
  ] as const;
  let h: Format4Fixture;
  let hdb: TestDb;
  beforeAll(async () => {
    // T1 split over two partitions, T2 with an error, T3; trace 99 has a log and no span
    h = await buildFormat4Report(
      [
        request(P0),
        request(P1),
        otlp(
          logsRequest(
            [logRecord({ severityNumber: 9, traceId: hex(99, 32), spanId: hex(99, 16) })],
            [attr('service.name', str('svc-a'))],
          ) as never,
        ),
      ],
      { close: false },
    );
    hdb = await openFixtureDb(h);
  });
  const hfilter = () =>
    buildFilter({ manifest: h.manifest, table: 'spans', condition: null, text: '', window: null }).filter;

  test.each(TRACE_SORTS)('allTraceRowsQuery equals traceRowsQuery, sorted by %o', (sort) => {
    const all = hdb.rows(allTraceRowsQuery(hfilter(), sort, 50).toString());
    expect(col(all, 'trace_id')).not.toContain(hex(99, 32));
    expect(all).toHaveLength(3);
    expect(all).toEqual(hdb.rows(traceRowsQuery(hfilter(), sort, 50).toString()));
  });

  test('the statement reads no spans', () => {
    expect(allTraceRowsQuery(hfilter(), TRACE_SORTS[0], 5).toString()).not.toMatch(/\bspans\b/);
  });
});

describe('a trace split over three partitions, mixed kinds and caps', () => {
  const many = (n: number, first: number): S[] =>
    Array.from({ length: n }, (_, i) => ({
      trace: 10 + first + i,
      id: 100 + first + i,
      svc: 'svc-a',
      name: `many-${first + i}`,
      startMs: 300 + i,
      durMs: 1,
      attrs: [attr('k.many', str(`v${first + i}`))],
    }));
  // T1: partition 0 (0-100 ms), partition 1 (10-60 ms), partition 2 (5000-5100 ms, after the window below)
  const Q0: S[] = [
    {
      trace: 1,
      id: 1,
      svc: 'svc-a',
      name: 'root',
      startMs: 0,
      durMs: 100,
      attrs: [attr('k.m', { intValue: '3' })],
    },
    ...many(6, 0),
  ];
  const Q1: S[] = [
    {
      trace: 1,
      id: 2,
      parent: 1,
      svc: 'svc-b',
      name: 'child',
      startMs: 10,
      durMs: 50,
      attrs: [attr('k.m', str('3'))],
    },
  ];
  const Q2: S[] = [{ trace: 1, id: 3, parent: 1, svc: 'svc-b', name: 'late', startMs: 5000, durMs: 100 }];
  let g: Format4Fixture;
  let gdb: TestDb;

  beforeAll(async () => {
    g = await buildFormat4Report([request(Q0), request(Q1), request(Q2)], { close: false });
    gdb = await openFixtureDb(g);
  });
  const grel = (ms: number): bigint => BASE + OFFSET + ns(ms) - g.epoch;
  const grun = (q: { toString(): string }): Row[] => gdb.rows(q.toString());
  const gfilter = (window: { start: number; end: number } | null = null) =>
    buildFilter({ manifest: g.manifest, table: 'spans', condition: null, text: '', window }).filter;

  test('a window that excludes the last partition leaves the trace row whole: summed counts, overall end', () => {
    const w = gfilter({ start: 0, end: Number(grel(200)) });
    expect(w.files.files.length).toBeLessThan(3);
    const spans = grun(spanRowsQuery(w, { column: 'start', dir: 'asc' }, 100));
    expect(col(spans, 'name')).not.toContain('late');
    const rows = grun(traceRowsQuery(w, { column: 'start', dir: 'asc' }, 100));
    const t1 = rows.find((r) => r.trace_id === hex(1, 32));
    expect(t1).toMatchObject({
      span_count: 3n,
      start_ns: grel(0),
      end_ns: grel(5100),
      duration_ns: ns(5100),
    });
    expect(
      grun(traceRowsQuery(gfilter(null), { column: 'start', dir: 'asc' }, 100)).find(
        (r) => r.trace_id === hex(1, 32),
      ),
    ).toEqual({ ...t1, total: expect.anything() });
  });

  test('an int 3 and a string "3" under one key are one value with the summed count and a mixed key', () => {
    const rows = grun(attributeFacetsQuery(gfilter(), 'spans', { facetValueCap: 10, facetKeyCap: 100 }, []));
    expect(rows.filter((r) => r.key === 'k.m')).toMatchObject([
      { key: 'k.m', kind: 'mixed', value: '3', n: 2n, total: 2n },
    ]);
  });

  test('past valueCap the rest is in total, not in the rows; keys_total counts the keys before the key cap', () => {
    const rows = grun(attributeFacetsQuery(gfilter(), 'spans', { facetValueCap: 4, facetKeyCap: 100 }, []));
    const many4 = rows.filter((r) => r.key === 'k.many');
    expect(many4).toHaveLength(4);
    expect(many4.every((r) => r.total === 6n)).toBe(true);
    const listed = many4.reduce((a, r) => a + Number(r.n), 0);
    expect(Number(many4[0]?.total) - listed).toBe(2); // what `other` becomes
    expect(new Set(col(rows, 'keys_total'))).toEqual(new Set([2n]));
    const capped = grun(attributeFacetsQuery(gfilter(), 'spans', { facetValueCap: 4, facetKeyCap: 1 }, []));
    expect(new Set(col(capped, 'key'))).toEqual(new Set(['k.many']));
    expect(new Set(col(capped, 'keys_total'))).toEqual(new Set([2n]));
  });

  test('coreFacetsQuery caps the values per key in SQL and keeps the key total', () => {
    const names = CORE_SPAN_FACETS.filter((c) => c.key === 'span.name');
    const rows = grun(coreFacetsQuery(gfilter(), 'spans', names, { facetValueCap: 3 }));
    expect(rows).toHaveLength(3);
    expect(new Set(col(rows, 'total'))).toEqual(new Set([9n])); // 6 many-* + root + child + late
  });

  test('spanRowsQuery counts with a scalar subquery and breaks ties by file and row', () => {
    const sqlText = spanRowsQuery(gfilter(), { column: 'start', dir: 'asc' }, 2).toString();
    expect(sqlText).not.toMatch(/OVER \(\)/);
    expect(sqlText).toMatch(/ORDER BY .*"span_id" ASC, "filename" ASC, "file_row_number" ASC/s);
    expect(new Set(col(grun(spanRowsQuery(gfilter(), { column: 'start', dir: 'asc' }, 2)), 'total'))).toEqual(
      new Set([9n]),
    );
  });

  test('the span statement of a trace is bounded by the trace’s start and end', () => {
    const q = traceSpansQuery(T1, ['x/spans.parquet'], 0n, { startNs: 10n, endNs: 20n });
    expect(String(q)).toContain('start_time_unix_nano BETWEEN 10 AND 20');
    expect(String(traceSpansQuery(T1, ['x/spans.parquet'], 0n))).not.toContain('BETWEEN');
    expect(String(traceSpansQuery(T1, ['x/spans.parquet'], 0n, null))).not.toContain('BETWEEN');
  });
  test('the bound keeps every span of the trace, including one starting exactly at its end', () => {
    const rows = run(tracePartitionsQuery(T1, true));
    const bound = traceBoundOf(rows);
    expect(bound).not.toBeNull();
    const files = rows.map((r) => String(r.filename).replace('traces.parquet', 'spans.parquet'));
    const all = run(traceSpansQuery(T1, files, f.epoch, bound));
    expect(col(all, 'span_id')).toEqual([1, 2, 3, 5].map((n) => hex(n, 16)));
    // the bound ends at the last start: that span (a zero-length one would be too) stays
    const tight = { startNs: bound?.startNs ?? 0n, endNs: f.epoch + (all[3]?.start_ns as bigint) };
    expect(col(run(traceSpansQuery(T1, files, f.epoch, tight)), 'span_id')).toHaveLength(4);
  });
  test('traceBoundOf spans the partitions and gives no bound when a side is missing', () => {
    expect(
      traceBoundOf([
        { filename: 'a', min_start: 5n, max_end: 9n },
        { filename: 'b', min_start: 2n, max_end: 7n },
      ]),
    ).toEqual({ startNs: 2n, endNs: 9n });
    expect(traceBoundOf([{ filename: 'a', min_start: null, max_end: null }])).toBeNull();
    expect(
      traceBoundOf([
        { filename: 'a', min_start: 5n, max_end: 9n },
        { filename: 'b', min_start: null, max_end: null },
      ]),
    ).toEqual({ startNs: 5n, endNs: 9n });
    expect(traceBoundOf([{ filename: 'a', min_start: 5n, max_end: null }])).toBeNull();
    expect(traceBoundOf([])).toBeNull();
  });
});
