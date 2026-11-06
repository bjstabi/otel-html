import { describe, expect, test } from 'vitest';
import { type ColumnSpec, decodeColumns } from '../../../src/format/columns.js';
import {
  absolute,
  type Context,
  logRow,
  pointRow,
  type Row,
  spanRow,
} from '../../../src/format/parquet/rows.js';
import { TABLE_COLUMNS } from '../../../src/format/parquet/schema.js';
import type { AnyValue, Attributes } from '../../../src/model/anyvalue.js';
import type { RelNanos, SpanId, TraceId, UnixNanos } from '../../../src/model/ids.js';
import type {
  LogRecordRecord,
  MetricPointRecord,
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
const int = (value: bigint): AnyValue => ({ kind: 'int', value });
const dbl = (value: number): AnyValue => ({ kind: 'double', value });
const bytes = (b: number[]): AnyValue => ({ kind: 'bytes', value: new Uint8Array(b) });
const attrs = (o: Record<string, AnyValue>): Attributes => new Map(Object.entries(o));

const resource: ResourceRecord = {
  attributes: attrs({ 'service.name': str('checkout'), 'host.name': str('node-1') }),
  droppedAttributesCount: 0,
  schemaUrl: '',
};
const scope: ScopeRecord = {
  name: 'lib',
  version: '1.0',
  attributes: attrs({}),
  droppedAttributesCount: 0,
  schemaUrl: '',
};
const ctx: Context = { epoch: EPOCH, resources: () => resource, scopes: () => scope };

function span(over: Partial<SpanRecord> = {}): SpanRecord {
  return {
    traceId: 'a'.repeat(32) as TraceId,
    spanId: 'b'.repeat(16) as SpanId,
    parentSpanId: null,
    traceState: '',
    flags: 0,
    name: 'GET /x',
    kind: 2,
    start: 5 as RelNanos,
    end: 15 as RelNanos,
    attributes: attrs({}),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: 0, message: '' },
    resource: RES,
    scope: SCOPE,
    ...over,
  };
}

function log(over: Partial<LogRecordRecord> = {}): LogRecordRecord {
  return {
    time: 7 as RelNanos,
    observedTime: null,
    severityNumber: 9,
    severityText: 'INFO',
    body: str('hello'),
    attributes: attrs({}),
    droppedAttributesCount: 0,
    flags: 0,
    traceId: null,
    spanId: null,
    eventName: '',
    resource: RES,
    scope: SCOPE,
    ...over,
  };
}

function point(over: Partial<MetricPointRecord> = {}): MetricPointRecord {
  return {
    name: 'requests',
    description: '',
    unit: '1',
    type: 'sum',
    temporality: 'delta',
    monotonic: true,
    start: null,
    time: 100 as RelNanos,
    attributes: attrs({}),
    flags: 0,
    point: { asInt: '3' },
    resource: RES,
    scope: SCOPE,
    ...over,
  };
}

/** A cell by column name (rows are index-signature records). */
const cell = (row: Row, name: string): unknown => row[name];

const jsonColumn: ColumnSpec<{ x: unknown }> = { columns: [{ name: 'x', kind: 'json' }] };

/** What the chunk format's JSON decoder makes of attribute JSON text. */
function decodeAsChunkJson(text: string): unknown {
  const payload = { v: 1, n: 1, dict: [text], base: 0, cols: { x: [0] }, resources: [], scopes: [] };
  return decodeColumns(jsonColumn, payload).rows[0]?.x;
}

function expectKeys(row: Row, table: 'spans' | 'logs' | 'points'): void {
  const known = TABLE_COLUMNS[table].map((c) => c.name);
  for (const k of Object.keys(row)) expect(known).toContain(k);
  for (const c of TABLE_COLUMNS[table]) if (!c.nullable) expect(row[c.name]).not.toBeUndefined();
}

describe('row mapping', () => {
  test('a span row carries absolute times and tagged attributes', () => {
    const row = spanRow(span({ attributes: attrs({ 'a.b"c': int(2n ** 60n), raw: bytes([1, 2]) }) }), ctx);
    expect(cell(row, 'start_time_unix_nano')).toBe(EPOCH + 5n);
    expect(cell(row, 'end_time_unix_nano')).toBe(EPOCH + 15n);
    expect(cell(row, 'duration_ns')).toBe(10n);
    expect(cell(row, 'parent_span_id')).toBeNull();
    expect(cell(row, 'status_code')).toBe(0);
    expect(cell(row, 'service_name')).toBe('checkout');
    expect(JSON.parse(cell(row, 'attributes') as string)).toEqual({
      'a.b"c': { $i: (2n ** 60n).toString() },
      raw: { $b: 'AQI=' },
    });
    expectKeys(row, 'spans');
  });

  test('a span that ends before it starts has zero duration', () => {
    const row = spanRow(span({ start: 20 as RelNanos, end: 10 as RelNanos }), ctx);
    expect(cell(row, 'duration_ns')).toBe(0n);
  });

  test('span events carry absolute times', () => {
    const row = spanRow(
      span({
        events: [{ time: 6 as RelNanos, name: 'e', attributes: attrs({}), droppedAttributesCount: 0 }],
      }),
      ctx,
    );
    const events = JSON.parse(cell(row, 'events') as string) as { time_unix_nano: unknown }[];
    expect(events[0]?.time_unix_nano).toEqual({ $i: (EPOCH + 6n).toString() });
  });

  test('non-finite doubles and $-prefixed keys survive', () => {
    const text = JSON.parse(
      cell(
        spanRow(
          span({
            attributes: attrs({
              a: dbl(-0),
              b: dbl(Number.NaN),
              c: dbl(Number.POSITIVE_INFINITY),
              d: dbl(1.5),
            }),
          }),
          ctx,
        ),
        'attributes',
      ) as string,
    );
    expect(text).toEqual({ a: { $d: '-0' }, b: { $d: 'NaN' }, c: { $d: 'Infinity' }, d: 1.5 });

    const dollar = spanRow(span({ attributes: attrs({ $x: str('v'), $i: str('7'), plain: int(1n) }) }), ctx);
    const json = cell(dollar, 'attributes') as string;
    // not an object a reader could mistake for a tag: the entries form keeps "$i" a key
    expect(JSON.parse(json)).toEqual({
      $m: [
        ['$x', 'v'],
        ['$i', '7'],
        ['plain', { $i: '1' }],
      ],
    });
    const decoded = decodeAsChunkJson(json);
    expect(decoded).toBeInstanceOf(Map);
    expect((decoded as Map<string, unknown>).get('$i')).toBe('7');
    expect((decoded as Map<string, unknown>).get('plain')).toBe(1n);
  });

  test('an attribute set without such keys decodes the way the chunk format decodes it', () => {
    const row = spanRow(
      span({
        attributes: attrs({
          n: int(2n ** 60n),
          b: bytes([1, 2]),
          nested: { kind: 'kvlist', values: attrs({ k: str('v') }) },
        }),
      }),
      ctx,
    );
    const json = cell(row, 'attributes') as string;
    expect(decodeAsChunkJson(json)).toEqual({ n: 2n ** 60n, b: new Uint8Array([1, 2]), nested: { k: 'v' } });
  });

  test('a log row has null trace ids when unset and the host name promoted', () => {
    const row = logRow(log({ body: { kind: 'empty' } }), ctx);
    expect(cell(row, 'trace_id')).toBeNull();
    expect(cell(row, 'span_id')).toBeNull();
    expect(cell(row, 'host_name')).toBe('node-1');
    expect(cell(row, 'time_unix_nano')).toBe(EPOCH + 7n);
    expect(cell(row, 'observed_time_unix_nano')).toBeNull();
    expect(cell(row, 'event_name')).toBeNull();
    expect(cell(row, 'body')).toBe('null');
    expectKeys(row, 'logs');
  });

  test('a log with no time keeps a null time and a named event keeps its name', () => {
    const row = logRow(log({ time: null, observedTime: 9 as RelNanos, eventName: 'user.login' }), ctx);
    expect(cell(row, 'time_unix_nano')).toBeNull();
    expect(cell(row, 'observed_time_unix_nano')).toBe(EPOCH + 9n);
    expect(cell(row, 'event_name')).toBe('user.login');
  });

  test('a point row carries the normalization columns verbatim', () => {
    const row = pointRow(
      point(),
      { deltaValue: 3, deltaCount: null, reset: true, outOfOrder: false, seriesId: 's1' },
      ctx,
    );
    expect(cell(row, 'delta_value')).toBe(3);
    expect(cell(row, 'delta_count')).toBeNull();
    expect(cell(row, 'reset')).toBe(true);
    expect(cell(row, 'out_of_order')).toBe(false);
    expect(cell(row, 'series_id')).toBe('s1');
    expect(cell(row, 'time_unix_nano')).toBe(EPOCH + 100n);
    expect(cell(row, 'start_time_unix_nano')).toBeNull();
    expect(cell(row, 'aggregation_temporality')).toBe(1);
    expectKeys(row, 'points');
  });

  test('absolute adds the epoch', () => {
    expect(absolute(-3 as RelNanos, EPOCH)).toBe(EPOCH - 3n);
  });
});
