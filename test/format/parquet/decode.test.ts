import { describe, expect, test } from 'vitest';
import {
  logFromRow,
  type ResultRow,
  SharedInterner,
  spanFromRow,
} from '../../../src/format/parquet/decode.js';
import { type Context, logRow, spanRow } from '../../../src/format/parquet/rows.js';
import type { AnyValue, Attributes } from '../../../src/model/anyvalue.js';
import { OtelHtmlError } from '../../../src/model/errors.js';
import type { RelNanos, SpanId, TraceId, UnixNanos } from '../../../src/model/ids.js';
import type {
  LogRecordRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
  SpanRecord,
} from '../../../src/model/records.js';

const EPOCH = 1_700_000_000_000_000_000n as UnixNanos;
const RES = 0 as ResourceRef;
const SCOPE = 0 as ScopeRef;

const str = (value: string): AnyValue => ({ kind: 'string', value });
const attrs = (o: Record<string, AnyValue>): Attributes => new Map(Object.entries(o));

const resource: ResourceRecord = {
  attributes: attrs({ 'service.name': str('checkout'), big: { kind: 'int', value: 2n ** 62n } }),
  droppedAttributesCount: 3,
  schemaUrl: 'https://schema/r',
};
const scope: ScopeRecord = {
  name: 'lib',
  version: '1.0',
  attributes: attrs({ s: { kind: 'bool', value: true } }),
  droppedAttributesCount: 1,
  schemaUrl: 'https://schema/s',
};
const ctx: Context = { epoch: EPOCH, resources: () => resource, scopes: () => scope };

const rich = attrs({
  big: { kind: 'int', value: 2n ** 60n },
  raw: { kind: 'bytes', value: new Uint8Array([1, 2, 255]) },
  d: { kind: 'double', value: 1.5 },
  arr: { kind: 'array', values: [str('x'), { kind: 'int', value: 7n }] },
  nested: { kind: 'kvlist', values: attrs({ k: str('v') }) },
});

function span(over: Partial<SpanRecord> = {}): SpanRecord {
  return {
    traceId: 'a'.repeat(32) as TraceId,
    spanId: 'b'.repeat(16) as SpanId,
    parentSpanId: 'c'.repeat(16) as SpanId,
    traceState: 'k=v',
    flags: 257,
    name: 'GET /x',
    kind: 2,
    start: 5 as RelNanos,
    end: 15 as RelNanos,
    attributes: rich,
    droppedAttributesCount: 2,
    events: [
      { time: 6 as RelNanos, name: 'ev', attributes: rich, droppedAttributesCount: 1 },
      { time: -3 as RelNanos, name: '', attributes: attrs({}), droppedAttributesCount: 0 },
    ],
    droppedEventsCount: 4,
    links: [
      {
        traceId: 'd'.repeat(32) as TraceId,
        spanId: 'e'.repeat(16) as SpanId,
        traceState: 'x=y',
        attributes: rich,
        droppedAttributesCount: 5,
        flags: 1,
      },
    ],
    droppedLinksCount: 6,
    status: { code: 2, message: 'boom' },
    resource: RES,
    scope: SCOPE,
    ...over,
  };
}

function log(over: Partial<LogRecordRecord> = {}): LogRecordRecord {
  return {
    time: 7 as RelNanos,
    observedTime: 9 as RelNanos,
    severityNumber: 9,
    severityText: 'INFO',
    body: { kind: 'kvlist', values: rich },
    attributes: rich,
    droppedAttributesCount: 2,
    flags: 1,
    traceId: 'a'.repeat(32) as TraceId,
    spanId: 'b'.repeat(16) as SpanId,
    eventName: 'my.event',
    resource: RES,
    scope: SCOPE,
    ...over,
  };
}

const cell = (row: Record<string, unknown>, name: string): unknown => row[name];

const TIME_COLUMNS = [
  'start_time_unix_nano',
  'end_time_unix_nano',
  'time_unix_nano',
  'observed_time_unix_nano',
];

/** What a query result delivers: the writer's row with its top-level time columns relative to the epoch (D2); the events JSON stays absolute. */
function asQueried(row: Record<string, unknown>): ResultRow {
  const out: Record<string, unknown> = { ...row };
  for (const c of TIME_COLUMNS) {
    const v = out[c];
    if (typeof v === 'bigint') out[c] = v - EPOCH;
  }
  return out;
}

describe('spanFromRow', () => {
  test('is the inverse of spanRow, resource and scope refs excepted', () => {
    const s = span();
    const { span: back, shared } = spanFromRow(asQueried(spanRow(s, ctx)), EPOCH);
    expect(back).toEqual({ ...s, resource: 0, scope: 0 });
    expect(shared.resource).toEqual(resource);
    expect(shared.scope).toEqual(scope);
  });

  test('a root span has a null parent', () => {
    const { span: back } = spanFromRow(asQueried(spanRow(span({ parentSpanId: null }), ctx)), EPOCH);
    expect(back.parentSpanId).toBeNull();
  });

  test('duration_ns is derived and clamped: start/end carry the truth, even when end < start', () => {
    const s = span({ start: 20 as RelNanos, end: 10 as RelNanos });
    const row = spanRow(s, ctx);
    expect(cell(row, 'duration_ns')).toBe(0n);
    const { span: back } = spanFromRow(asQueried(row), EPOCH);
    expect(back.start).toBe(20);
    expect(back.end).toBe(10);
  });

  test('int columns may arrive as numbers (int32) or bigint (int64)', () => {
    const row = { ...asQueried(spanRow(span(), ctx)), flags: 257, dropped_events_count: 4 };
    const { span: back } = spanFromRow(row, EPOCH);
    expect(back.flags).toBe(257);
    expect(back.droppedEventsCount).toBe(4);
  });

  test('a time outside the safe range fails with time-out-of-range, not rounding', () => {
    const row = { ...asQueried(spanRow(span(), ctx)), end_time_unix_nano: 2n ** 60n };
    expect(() => spanFromRow(row, EPOCH)).toThrow(OtelHtmlError);
    try {
      spanFromRow(row, EPOCH);
    } catch (e) {
      expect((e as OtelHtmlError).code).toBe('time-out-of-range');
    }
  });

  test('an event time beyond 2^53 relative fails too', () => {
    const row = asQueried(spanRow(span(), ctx));
    const events = JSON.parse(cell(row, 'events') as string);
    events[0].time_unix_nano = { $i: (EPOCH + 2n ** 60n).toString() };
    expect(() => spanFromRow({ ...row, events: JSON.stringify(events) }, EPOCH)).toThrow(OtelHtmlError);
  });

  test('a missing or mistyped column is an invalid-report error', () => {
    const { name: _n, ...rest } = asQueried(spanRow(span(), ctx));
    expect(() => spanFromRow(rest, EPOCH)).toThrow(OtelHtmlError);
  });
});

describe('logFromRow', () => {
  test('is the inverse of logRow, resource and scope refs excepted', () => {
    const l = log();
    const { log: back, shared } = logFromRow(asQueried(logRow(l, ctx)));
    expect(back).toEqual({ ...l, resource: 0, scope: 0 });
    expect(shared.resource).toEqual(resource);
    expect(shared.scope).toEqual(scope);
  });

  test('an empty event name is stored as null (R9) and decodes back to the empty string', () => {
    const row = logRow(log({ eventName: '' }), ctx);
    expect(cell(row, 'event_name')).toBeNull();
    expect(logFromRow(asQueried(row)).log.eventName).toBe('');
  });

  test('null times and null ids stay null', () => {
    const l = log({ time: null, observedTime: null, traceId: null, spanId: null });
    const { log: back } = logFromRow(asQueried(logRow(l, ctx)));
    expect(back).toEqual({ ...l, resource: 0, scope: 0 });
  });

  test('a string body round-trips', () => {
    const l = log({ body: str('hello') });
    expect(logFromRow(asQueried(logRow(l, ctx))).log.body).toEqual(str('hello'));
  });
});

describe('SharedInterner', () => {
  test('equal resources and scopes share a ref, different ones get new refs', () => {
    const i = new SharedInterner();
    const a = i.resource(resource);
    const copy: ResourceRecord = { ...resource, attributes: new Map(resource.attributes) };
    expect(i.resource(copy)).toBe(a);
    const other = i.resource({ ...resource, droppedAttributesCount: 4 });
    expect(other).not.toBe(a);
    const s = i.scope(scope);
    expect(i.scope({ ...scope })).toBe(s);
    expect(i.scope({ ...scope, version: '2' })).not.toBe(s);
    expect(i.resources).toHaveLength(2);
    expect(i.scopes).toHaveLength(2);
    expect(i.resources[a]).toEqual(resource);
    expect(i.scopes[s]).toEqual(scope);
  });
});
