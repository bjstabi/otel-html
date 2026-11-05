import { describe, expect, test } from 'vitest';
import type { RelNanos, SpanId, TraceId, UnixNanos } from '../../src/model/ids.js';
import type {
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
  SpanRecord,
} from '../../src/model/records.js';
import { StatusCode } from '../../src/model/records.js';
import {
  querySpanEntries,
  type SpanEntry,
  type SpanQuery,
  SpanQueryRun,
  type SpanRow,
  toEntries,
} from '../../src/viewer/data/span-query.js';
import { medianMs } from '../../test-support/median-ms.js';
import { perfFactor } from '../../test-support/perf-inject.js';

const resources: ResourceRecord[] = ['api', 'db', 'cache'].map((s) => ({
  attributes: new Map([['service.name', { kind: 'string', value: s }]]),
  droppedAttributesCount: 0,
  schemaUrl: '',
}));
const scopes: ScopeRecord[] = [
  { name: 'scope', version: '', attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' },
];

/** Cheap synthetic spans: 1 in 50 errors, 3 services, 40 names, 8 traces' worth of repetition per 100. */
function synthetic(n: number): SpanEntry[] {
  const spans: SpanRecord[] = new Array<SpanRecord>(n);
  const status = { code: StatusCode.UNSET, message: '' };
  const error = { code: StatusCode.ERROR, message: 'boom' };
  const attributes = new Map();
  for (let i = 0; i < n; i++) {
    spans[i] = {
      traceId: `${(i % 5000).toString(16).padStart(32, '0')}` as TraceId,
      spanId: i.toString(16).padStart(16, '0') as SpanId,
      parentSpanId: null,
      traceState: '',
      flags: 0,
      name: `op${i % 40}`,
      kind: 1,
      start: (i * 1000) as RelNanos,
      end: (i * 1000 + 500 + (i % 97) * 10) as RelNanos,
      attributes,
      droppedAttributesCount: 0,
      events: [],
      droppedEventsCount: 0,
      links: [],
      droppedLinksCount: 0,
      status: i % 50 === 0 ? error : status,
      resource: (i % 3) as ResourceRef,
      scope: 0 as ScopeRef,
    };
  }
  return toEntries({ n: 0, resources, scopes }, spans, 0n as UnixNanos, 'synthetic');
}

const query = (over: Partial<SpanQuery>): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'duration', dir: 'desc' },
  limit: 100,
  groupBy: null,
  measureBy: null,
  scanAll: false,
  ...over,
});

describe('querySpanEntries', () => {
  test('@perf filters 100k spans in memory under 150 ms (median)', () => {
    const entries = synthetic(100_000);
    const q = query({ condition: 'status.code == STATUS_CODE_ERROR' });
    const { result: r, ms } = medianMs(() => querySpanEntries(entries, q));
    expect(r.total).toBe(2000);
    expect(r.rows).toHaveLength(100);
    expect(r.facets.total('service.name')).toBe(2000);
    expect(r.partial).toBeNull();
    expect(ms).toBeLessThan(150 * perfFactor());
  });

  test('sorts by the requested column and direction, ties by start', () => {
    const entries = synthetic(300);
    const asc = querySpanEntries(entries, query({ sort: { column: 'name', dir: 'asc' }, limit: 3 }));
    expect((asc.rows as SpanRow[]).map((r) => r.span.name)).toEqual(['op0', 'op0', 'op0']);
    const starts = (asc.rows as SpanRow[]).map((r) => r.span.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  test('a limit of 0 returns no rows but still counts', () => {
    const r = querySpanEntries(synthetic(100), query({ limit: 0 }));
    expect(r.rows).toEqual([]);
    expect(r.total).toBe(100);
  });

  test('rejects an invalid limit and an aborted signal up front', () => {
    expect(() => querySpanEntries([], query({ limit: -1 }))).toThrow(/query\.limit/);
    const ac = new AbortController();
    ac.abort();
    expect(() => querySpanEntries(synthetic(10), query({}), ac.signal)).toThrow(/aborted/);
  });

  test('a signal aborted during a long scan stops it', () => {
    const entries = synthetic(20_000);
    const ac = new AbortController();
    let seen = 0;
    const spy = entries.map((e) => ({
      ...e,
      get target() {
        if (++seen === 5000) ac.abort();
        return e.target;
      },
    }));
    expect(() => querySpanEntries(spy, query({ condition: 'name == "op1"' }), ac.signal)).toThrow(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(seen).toBeLessThan(10_000);
  });
});

describe('SpanQueryRun row buffer', () => {
  const keyOf: Record<string, (r: SpanRow) => number | string> = {
    duration: (r) => r.durationNs,
    name: (r) => r.span.name,
    start: (r) => r.span.start,
  };

  test.each([0, 1, 7, 100, 5000])('limit %i lists the same rows as a full sort', (limit) => {
    const entries = synthetic(20_000);
    const rows = entries.map((e) => e.row);
    for (const [column, dir] of [
      ['duration', 'desc'],
      ['duration', 'asc'],
      ['name', 'asc'],
      ['start', 'desc'],
    ] as const) {
      const key = keyOf[column] as (r: SpanRow) => number | string;
      const sign = dir === 'asc' ? 1 : -1;
      const expected = [...rows]
        .sort((a, b) => {
          const ka = key(a);
          const kb = key(b);
          const c = ka < kb ? -1 : ka > kb ? 1 : 0;
          return sign * c || a.span.start - b.span.start;
        })
        .slice(0, limit);
      const r = querySpanEntries(entries, query({ sort: { column, dir }, limit }));
      expect(r.rows).toEqual(expected);
      expect(r.total).toBe(20_000);
    }
  });

  test('equal sort keys and starts keep input order across compactions', () => {
    const entries = synthetic(5000).map((e) => ({
      ...e,
      row: { ...e.row, span: { ...e.row.span, start: 0 as RelNanos, end: 500 as RelNanos }, durationNs: 500 },
    }));
    const r = querySpanEntries(entries, query({ sort: { column: 'duration', dir: 'desc' }, limit: 1500 }));
    expect(r.rows).toEqual(entries.slice(0, 1500).map((e) => e.row));
  });

  test('a limit above the match count lists every match in order', () => {
    const r = querySpanEntries(
      synthetic(20_000),
      query({
        condition: 'status.code == STATUS_CODE_ERROR',
        sort: { column: 'start', dir: 'asc' },
        limit: 5000,
      }),
    );
    expect(r.total).toBe(400);
    expect(r.rows.map((x) => ('span' in x ? x.span.start : -1))).toEqual(
      Array.from({ length: 400 }, (_, i) => i * 50 * 1000),
    );
  });

  test('holds at most limit plus the compaction slack however many spans it sees', () => {
    const run = new SpanQueryRun(query({ limit: 1 }));
    for (const e of synthetic(10_000)) run.visit(e);
    expect(run.heldRows).toBeLessThanOrEqual(1 + 1024);
    expect(run.units).toBe(10_000);
  });

  test('traces mode holds no matched rows', () => {
    const run = new SpanQueryRun(query({ mode: 'traces', sort: { column: 'start', dir: 'asc' } }));
    for (const e of synthetic(1000)) run.visit(e);
    expect(run.heldRows).toBe(0);
    expect(run.finish(null).total).toBe(1000);
  });
});

describe('measureBy', () => {
  const span = (i: number, svc: number, ms: number, attrs: [string, string][] = []): SpanRecord => ({
    traceId: i.toString(16).padStart(32, '0') as TraceId,
    spanId: i.toString(16).padStart(16, '0') as SpanId,
    parentSpanId: null,
    traceState: '',
    flags: 0,
    name: 'op',
    kind: 1,
    start: 0 as RelNanos,
    end: (ms * 1e6) as RelNanos,
    attributes: new Map(attrs.map(([k, v]) => [k, { kind: 'string' as const, value: v }])),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: StatusCode.UNSET, message: '' },
    resource: svc as ResourceRef,
    scope: 0 as ScopeRef,
  });
  const entries = (spans: SpanRecord[]): SpanEntry[] =>
    toEntries({ n: 0, resources, scopes }, spans, 0n as UnixNanos, 'measure');
  const three = (): SpanEntry[] => entries([span(1, 0, 10), span(2, 0, 30), span(3, 1, 50)]);

  test('measureBy collects a duration histogram per group', () => {
    const { groups } = querySpanEntries(three(), query({ measureBy: 'service.name' }));
    expect(groups?.get('api')?.count).toBe(2);
    expect(groups?.get('api')?.max).toBe(30e6);
    expect(groups?.get('api')?.sum).toBe(40e6);
    expect(groups?.get('db')?.count).toBe(1);
    expect(groups?.size).toBe(2);
  });

  test("a single-span group's p95 is its duration within the histogram bound", () => {
    const { groups } = querySpanEntries(three(), query({ measureBy: 'service.name' }));
    const h = groups?.get('db');
    const q = h?.quantile(0.95) ?? Number.NaN;
    expect(q).toBeGreaterThanOrEqual(50e6);
    expect(q).toBeLessThanOrEqual(50e6 * 2 ** (2 ** -(h?.scale ?? 0)));
  });

  test('measureBy null leaves groups null', () => {
    expect(querySpanEntries(three(), query({})).groups).toBeNull();
  });

  test('a span attribute is a measure key; spans without it are skipped', () => {
    const e = entries([span(1, 0, 10, [['http.route', '/x']]), span(2, 0, 20)]);
    const { groups } = querySpanEntries(e, query({ measureBy: 'http.route' }));
    expect(groups?.get('/x')?.count).toBe(1);
    expect(groups?.size).toBe(1);
  });

  test('only matched spans are aggregated', () => {
    const { groups } = querySpanEntries(
      three(),
      query({ measureBy: 'service.name', condition: 'name == "none"' }),
    );
    expect(groups?.size).toBe(0);
  });
});
