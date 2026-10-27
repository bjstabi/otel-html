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
  type SpanRow,
  toEntries,
} from '../../src/viewer/data/span-query.js';
import { medianMs } from '../../test-support/median-ms.js';

declare const process: { env: { OTEL_HTML_PERF_FACTOR?: string } }; // provided by vitest; the viewer project has no node types

const PERF_FACTOR = Number(process.env.OTEL_HTML_PERF_FACTOR ?? '1');

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
  scanAll: false,
  ...over,
});

describe('querySpanEntries', () => {
  test('filters 100k spans in memory under 150 ms (median)', () => {
    const entries = synthetic(100_000);
    const q = query({ condition: 'status.code == STATUS_CODE_ERROR' });
    const { result: r, ms } = medianMs(() => querySpanEntries(entries, q));
    expect(r.total).toBe(2000);
    expect(r.rows).toHaveLength(100);
    expect(r.facets.total('service.name')).toBe(2000);
    expect(r.partial).toBeNull();
    expect(ms).toBeLessThan(150 * PERF_FACTOR);
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
