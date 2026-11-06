import { describe, expect, test } from 'vitest';
import {
  anyValueFromJson,
  anyValueJson,
  attributesFromJson,
  attributesToJson,
} from '../../../src/format/columns.js';
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
import { OtelHtmlError } from '../../../src/model/errors.js';
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
const bool = (value: boolean): AnyValue => ({ kind: 'bool', value });
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
    const small = spanRow(span({ attributes: attrs({ 'http.status_code': int(200n) }) }), ctx);
    expect(JSON.parse(cell(small, 'attributes') as string)).toEqual({ 'http.status_code': 200 });
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
        ['plain', 1],
      ],
    });
    expect(attributesFromJson(json)).toEqual(attrs({ $x: str('v'), $i: str('7'), plain: int(1n) }));
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

  test('a delta count that cannot be an int64 becomes null instead of throwing', () => {
    const n = { deltaValue: null, reset: false, outOfOrder: false, seriesId: 's' };
    expect(cell(pointRow(point(), { ...n, deltaCount: 2 ** 60 }, ctx), 'delta_count')).toBe(2n ** 60n);
    for (const bad of [1.5, 2 ** 70, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(cell(pointRow(point(), { ...n, deltaCount: bad }, ctx), 'delta_count')).toBeNull();
    }
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

describe('format-4 attribute JSON', () => {
  const nested: AnyValue = {
    kind: 'kvlist',
    values: attrs({
      list: {
        kind: 'array',
        values: [int(1n), dbl(1), dbl(1.5), { kind: 'empty' }, str('s'), bytes([0, 255])],
      },
      inner: { kind: 'kvlist', values: attrs({ $x: bool(true), plain: str('p') }) },
    }),
  };
  const base = attrs({
    'a.b"c': str('quoted'),
    'a.b': int(7n),
    $x: str('dollar'),
    $i: int(5n),
    max: int(2n ** 53n - 1n),
    min: int(-(2n ** 53n - 1n)),
    over: int(2n ** 53n),
    under: int(-(2n ** 53n)),
    i64max: int(2n ** 63n - 1n),
    i64min: int(-(2n ** 63n)),
    two_int: int(2n),
    two_dbl: dbl(2),
    neg_zero: dbl(-0),
    nan: dbl(Number.NaN),
    inf: dbl(Number.POSITIVE_INFINITY),
    ninf: dbl(Number.NEGATIVE_INFINITY),
    half: dbl(0.5),
    huge: dbl(1e300),
    big_whole: dbl(2 ** 60),
    raw: bytes([1, 2]),
    nested,
  });
  const set: Attributes = new Map([...base, ['__proto__', str('proto')]]);

  test('ints are plain numbers within 2^53-1, doubles are plain only when not whole', () => {
    const dollarFree = new Map([...set].filter(([k]) => !k.startsWith('$') && k !== '__proto__'));
    const json: unknown = JSON.parse(attributesToJson(dollarFree));
    expect(json).toMatchObject({
      max: 2 ** 53 - 1,
      min: -(2 ** 53 - 1),
      over: { $i: (2n ** 53n).toString() },
      two_int: 2,
      two_dbl: { $d: '2' },
      neg_zero: { $d: '-0' },
      nan: { $d: 'NaN' },
      half: 0.5,
    });
  });

  test('a __proto__ key forces the entries form and survives as a key', () => {
    const withProto: Attributes = new Map([
      ['__proto__', str('proto')],
      ['ok', int(1n)],
    ]);
    const json = attributesToJson(withProto);
    expect(Object.keys(JSON.parse(json) as object)).toEqual(['$m']);
    const back = attributesFromJson(json);
    expect(back.has('__proto__')).toBe(true);
    expect(back.get('__proto__')).toEqual(str('proto'));
    expect(back).toEqual(withProto);
  });

  test('a mixed attribute set round-trips exactly', () => {
    const back = attributesFromJson(attributesToJson(set));
    expect([...back.keys()]).toEqual([...set.keys()]);
    expect(back).toEqual(set);
    expect(Object.is((back.get('neg_zero') as { value: number }).value, -0)).toBe(true);
    expect(back.get('two_int')).toEqual(int(2n));
    expect(back.get('two_dbl')).toEqual(dbl(2));
  });

  test('a set without $ keys is an object and round-trips', () => {
    const plain = attrs({ 'a.b"c': int(2n ** 60n), n: int(3n), nested });
    const json = attributesToJson(plain);
    expect(Object.keys(JSON.parse(json) as object)).toEqual(['a.b"c', 'n', 'nested']);
    expect(attributesFromJson(json)).toEqual(plain);
  });

  test('single values round-trip', () => {
    for (const v of [
      str('x'),
      int(0n),
      int(-1n),
      dbl(0),
      dbl(-0),
      dbl(0.1),
      { kind: 'empty' } as AnyValue,
      nested,
    ]) {
      expect(anyValueFromJson(anyValueJson(v))).toEqual(v);
    }
  });

  test('malformed or mis-tagged JSON is a typed error', () => {
    const codes = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (e) {
        return e instanceof OtelHtmlError ? e.code : 'other';
      }
      return undefined;
    };
    expect(codes(() => attributesFromJson('{'))).toBe('invalid-report');
    expect(codes(() => attributesFromJson('[]'))).toBe('invalid-report');
    expect(codes(() => attributesFromJson('{"$i":"1"}'))).toBe('invalid-report');
    expect(codes(() => attributesFromJson('{"a":{"$i":"x"}}'))).toBe('invalid-report');
    expect(codes(() => attributesFromJson('{"a":{"$d":"abc"}}'))).toBe('invalid-report');
    expect(codes(() => attributesFromJson('{"a":1e300}'))).toBe('invalid-report');
    expect(codes(() => attributesFromJson('{"a":{"$m":3}}'))).toBe('invalid-report');
    expect(codes(() => anyValueFromJson('{"$q":1}'))).toBe('invalid-report');
  });
});

describe('point value columns', () => {
  const norm = { deltaValue: null, deltaCount: null, reset: false, outOfOrder: false, seriesId: 's' };
  const row = (over: Partial<MetricPointRecord>): Row => pointRow(point(over), norm, ctx);

  test('a gauge or sum carries value_double from asDouble or asInt', () => {
    const g = row({ type: 'gauge', point: { asDouble: 1.5 } });
    expect(cell(g, 'value_double')).toBe(1.5);
    expect(cell(row({ type: 'sum', point: { asInt: '42' } }), 'value_double')).toBe(42);
    expect(cell(row({ type: 'gauge', point: { asDouble: 'NaN' } }), 'value_double')).toBeNaN();
    expect(cell(row({ type: 'gauge', point: {} }), 'value_double')).toBeNull();
    expectKeys(g, 'points');
    expect(cell(g, 'point_type')).toBe('gauge');
    expect(cell(row({ type: 'sum', point: {} }), 'point_type')).toBe('sum');
  });

  test('a histogram carries count, sum, min, max, bounds and bucket counts', () => {
    const r = row({
      type: 'histogram',
      point: {
        count: '6',
        sum: 12.5,
        min: 0.5,
        max: 9,
        explicitBounds: [1, 5, 'Infinity'],
        bucketCounts: ['1', '2', '3', '9223372036854775807'],
      },
    });
    expect(cell(r, 'count')).toBe(6n);
    expect(cell(r, 'sum')).toBe(12.5);
    expect(cell(r, 'min')).toBe(0.5);
    expect(cell(r, 'max')).toBe(9);
    expect(cell(r, 'explicit_bounds')).toEqual([1, 5, Number.POSITIVE_INFINITY]);
    expect(cell(r, 'bucket_counts')).toEqual([1n, 2n, 3n, 9223372036854775807n]);
    expect(cell(r, 'point_type')).toBe('histogram');
    expect(() => row({ type: 'histogram', point: { bucketCounts: ['18446744073709551615'] } })).toThrowError(
      expect.objectContaining({ code: 'invalid-report' }),
    );
    expectKeys(r, 'points');
  });

  test('an exponential histogram carries scale, zero count and bucket offsets and counts', () => {
    const r = row({
      type: 'exponentialHistogram',
      point: {
        count: '7',
        scale: -2,
        zeroCount: '1',
        zeroThreshold: 0.001,
        positive: { offset: 3, bucketCounts: ['2', '4'] },
        negative: { bucketCounts: ['1'] },
        sum: 3,
      },
    });
    expect(cell(r, 'count')).toBe(7n);
    expect(cell(r, 'scale')).toBe(-2);
    expect(cell(r, 'zero_count')).toBe(1n);
    expect(cell(r, 'zero_threshold')).toBe(0.001);
    expect(cell(r, 'positive_offset')).toBe(3);
    expect(cell(r, 'positive_counts')).toEqual([2n, 4n]);
    expect(cell(r, 'negative_offset')).toBe(0);
    expect(cell(r, 'negative_counts')).toEqual([1n]);
    expect(cell(r, 'min')).toBeNull();
    expectKeys(r, 'points');
    const none = row({ type: 'exponentialHistogram', point: {} });
    expect(cell(none, 'scale')).toBe(0);
    expect(cell(none, 'zero_threshold')).toBe(0);
    expect(cell(row({ type: 'histogram', point: {} }), 'zero_threshold')).toBeUndefined();
    expect(cell(none, 'positive_offset')).toBeNull();
    expect(cell(none, 'positive_counts')).toBeNull();
    expect(cell(r, 'point_type')).toBe('exp_histogram');
  });

  test('a summary carries count, sum and tagged quantiles', () => {
    const r = row({
      type: 'summary',
      point: { count: '4', sum: 10, quantileValues: [{ quantile: 0.5, value: 2 }, { value: -0 }] },
    });
    expect(cell(r, 'count')).toBe(4n);
    expect(cell(r, 'sum')).toBe(10);
    expect(cell(r, 'point_type')).toBe('summary');
    expect(JSON.parse(cell(r, 'quantiles') as string)).toEqual([
      { quantile: 0.5, value: { $d: '2' } },
      { value: { $d: '-0' } },
    ]);
    expect(cell(row({ type: 'summary', point: {} }), 'sum')).toBe(0);
    expectKeys(r, 'points');
  });

  test('exemplars keep -0 and whole doubles tagged', () => {
    const r = row({ point: { asInt: '1', exemplars: [{ asDouble: -0 }, { asDouble: 1.25 }] } });
    expect(JSON.parse(cell(r, 'exemplars') as string)).toEqual([
      { asDouble: { $d: '-0' } },
      { asDouble: 1.25 },
    ]);
    expect(cell(row({ point: { asInt: '1' } }), 'exemplars')).toBeNull();
  });

  test('a malformed point field is a typed error', () => {
    expect(() => row({ type: 'histogram', point: { count: 5 } })).toThrow(OtelHtmlError);
  });
});
