import { describe, expect, test } from 'vitest';
import type { RelNanos, SpanId, TraceId, UnixNanos } from '../../src/model/ids.js';
import type { ResourceRef, ScopeRef, SpanRecord } from '../../src/model/records.js';
import { StatusCode } from '../../src/model/records.js';
import { facetValueOf, GroupDurations } from '../../src/rollups/span-rollups.js';
import { toEntries } from '../../src/viewer/data/span-query.js';

const span: SpanRecord = {
  traceId: '1'.padStart(32, '0') as TraceId,
  spanId: '1'.padStart(16, '0') as SpanId,
  parentSpanId: null,
  traceState: '',
  flags: 0,
  name: 'GET /x',
  kind: 2,
  start: 0 as RelNanos,
  end: 10 as RelNanos,
  attributes: new Map([['http.route', { kind: 'string' as const, value: '/x' }]]),
  droppedAttributesCount: 0,
  events: [],
  droppedEventsCount: 0,
  links: [],
  droppedLinksCount: 0,
  status: { code: StatusCode.UNSET, message: '' },
  resource: 0 as ResourceRef,
  scope: 0 as ScopeRef,
};
const [entry] = toEntries(
  {
    n: 0,
    resources: [
      {
        attributes: new Map([['service.name', { kind: 'string' as const, value: 'api' }]]),
        droppedAttributesCount: 0,
        schemaUrl: '',
      },
    ],
    scopes: [{ name: 's', version: '', attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' }],
  },
  [span],
  0n as UnixNanos,
  'x',
);
const target = (() => {
  if (entry === undefined) throw new Error('no entry');
  return entry.target;
})();

describe('facetValueOf', () => {
  test('a core key, an attribute key and an absent key', () => {
    expect(facetValueOf(target, 'service.name')).toBe('api');
    expect(facetValueOf(target, 'span.kind')).toBe('server');
    expect(facetValueOf(target, 'http.route')).toBe('/x');
    expect(facetValueOf(target, 'nope')).toBeUndefined();
  });
});

describe('GroupDurations', () => {
  test('past the cap a new group is dropped and counted; an existing group still accumulates', () => {
    const g = new GroupDurations(2);
    g.add('a', 1);
    g.add('b', 2);
    g.add('c', 3);
    g.add('a', 4);
    expect(g.size).toBe(2);
    expect(g.get('c')).toBeUndefined();
    expect(g.get('a')?.count).toBe(2);
    expect(g.dropped).toBe(1);
    g.add('c', 5);
    expect(g.dropped).toBe(2);
    expect(g.cap).toBe(2);
  });
});
