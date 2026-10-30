import {
  create,
  type DescMessage,
  type JsonObject,
  type JsonValue,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { ExportMetricsServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import {
  AnyValueSchema,
  KeyValueSchema,
} from '../../src/model/gen/opentelemetry/proto/common/v1/common_pb.js';
import {
  type Exemplar,
  ExemplarSchema,
  ExponentialHistogramDataPointSchema,
  HistogramDataPointSchema,
  type NumberDataPoint,
  NumberDataPointSchema,
  SummaryDataPointSchema,
} from '../../src/model/gen/opentelemetry/proto/metrics/v1/metrics_pb.js';
import { parseUnixNanos } from '../../src/model/ids.js';
import {
  createNormalizeContext,
  earliestTimestamp,
  normalizeLogs,
  normalizeMetrics,
  normalizeTraces,
} from '../../src/model/normalize.js';
import { type OtlpRequest, parseOtlpJson } from '../../src/model/otlp-json.js';
import { StatusCode } from '../../src/model/records.js';
import {
  attr,
  gauge,
  logRecord,
  logsRequest,
  metricsRequest,
  SPAN_ID,
  span,
  T0,
  TRACE_ID,
  traceRequest,
} from '../../test-support/otlp-builders.js';

const epoch = parseUnixNanos(T0, 'epoch');

function only(json: unknown): OtlpRequest {
  const [r] = parseOtlpJson(JSON.stringify(json), 'f.json');
  if (r === undefined) throw new Error('no request');
  return r;
}
function traces(json: unknown) {
  const r = only(json);
  if (r.signal !== 'traces') throw new Error('not traces');
  return { ctx: createNormalizeContext(epoch), req: r.request };
}

describe('normalizeTraces', () => {
  test('maps fields, relative times, status and parent', () => {
    const { ctx, req } = traces(
      traceRequest([
        span({
          parentSpanId: '0102030405060708',
          startTimeUnixNano: '1700000000000000500',
          endTimeUnixNano: '1700000000000002500',
          status: { code: 2, message: 'boom' },
          events: [
            {
              timeUnixNano: '1700000000000001000',
              name: 'ev',
              attributes: [attr('k', { stringValue: 'v' })],
            },
          ],
          links: [{ traceId: TRACE_ID, spanId: SPAN_ID, traceState: 'a=b' }],
          droppedAttributesCount: 3,
        }),
      ]),
    );
    const [s] = normalizeTraces(req, ctx, 'f.json');
    expect(s?.parentSpanId).toBe('0102030405060708');
    expect(s?.start).toBe(500);
    expect(s?.end).toBe(2500);
    expect(s?.status).toEqual({ code: StatusCode.ERROR, message: 'boom' });
    expect(s?.events[0]?.time).toBe(1000);
    expect(s?.events[0]?.attributes.get('k')).toEqual({ kind: 'string', value: 'v' });
    expect(s?.links[0]).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID, traceState: 'a=b' });
    expect(s?.droppedAttributesCount).toBe(3);
  });

  test('resources and scopes are interned across spans', () => {
    const { ctx, req } = traces(
      traceRequest([span(), span({ name: 'b' })], [attr('service.name', { stringValue: 'svc' })]),
    );
    const [a, b] = normalizeTraces(req, ctx, 'f.json');
    expect(a?.resource).toBe(b?.resource);
    expect(a?.scope).toBe(b?.scope);
    expect(ctx.resources.entries()).toHaveLength(1);
    expect(ctx.scopes.get(a?.scope ?? (0 as never)).name).toBe('test-scope');
  });

  test('missing span id and out-of-range times fail with the JSON path', () => {
    const noId = traces({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: TRACE_ID, name: 'x' }] }] }] });
    expect(() => normalizeTraces(noId.req, noId.ctx, 'f.json')).toThrowError(
      /^f\.json: resourceSpans\[0\]\.scopeSpans\[0\]\.spans\[0\]\.spanId: expected 16 hex chars/,
    );
    const far = traces(traceRequest([span({ startTimeUnixNano: '1800000000000000000' })]));
    try {
      normalizeTraces(far.req, far.ctx, 'f.json');
      expect.unreachable();
    } catch (e) {
      expect(e instanceof OtelHtmlError && e.code).toBe('time-out-of-range');
      expect(String(e)).toMatch(/spans\[0\]\.startTimeUnixNano/);
    }
  });
});

describe('normalizeLogs', () => {
  test('zero timestamps and ids are absent; ids link to spans', () => {
    const r = only(
      logsRequest([
        logRecord({ timeUnixNano: '0', traceId: '0'.repeat(32), spanId: '0'.repeat(16) }),
        logRecord({
          traceId: TRACE_ID,
          spanId: SPAN_ID,
          eventName: 'ev',
          body: { kvlistValue: { values: [] } },
        }),
      ]),
    );
    if (r.signal !== 'logs') throw new Error('not logs');
    const [a, b] = normalizeLogs(r.request, createNormalizeContext(epoch), 'f.json');
    expect(a).toMatchObject({ time: null, observedTime: 0, traceId: null, spanId: null, severityNumber: 9 });
    expect(b).toMatchObject({ time: 0, traceId: TRACE_ID, spanId: SPAN_ID, eventName: 'ev' });
    expect(b?.body).toEqual({ kind: 'kvlist', values: new Map() });
  });
});

describe('normalizeMetrics', () => {
  test('covers every point kind with temporality, monotonicity and exemplars', () => {
    const t = '1700000000000000100';
    const r = only(
      metricsRequest([
        gauge('g', [
          { timeUnixNano: t, asDouble: 2.5, attributes: [attr('a', { stringValue: 'x' })], flags: 1 },
        ]),
        {
          name: 's',
          sum: {
            aggregationTemporality: 1,
            isMonotonic: true,
            dataPoints: [
              {
                startTimeUnixNano: T0,
                timeUnixNano: t,
                asInt: '9007199254740993',
                exemplars: [{ timeUnixNano: t, asDouble: 1, traceId: TRACE_ID, spanId: SPAN_ID }],
              },
            ],
          },
        },
        {
          name: 'h',
          histogram: {
            aggregationTemporality: 2,
            dataPoints: [
              { timeUnixNano: t, count: '3', sum: 6, bucketCounts: ['1', '2'], explicitBounds: [1] },
            ],
          },
        },
        {
          name: 'e',
          exponentialHistogram: {
            aggregationTemporality: 2,
            dataPoints: [
              {
                timeUnixNano: t,
                count: '2',
                scale: 1,
                zeroCount: '1',
                positive: { offset: 1, bucketCounts: ['1'] },
              },
            ],
          },
        },
        {
          name: 'q',
          summary: {
            dataPoints: [
              { timeUnixNano: t, count: '2', sum: 3, quantileValues: [{ quantile: 0.5, value: 1 }] },
            ],
          },
        },
        { name: 'empty' },
      ]),
    );
    if (r.signal !== 'metrics') throw new Error('not metrics');
    const pts = normalizeMetrics(r.request, createNormalizeContext(epoch), 'f.json');
    expect(pts.map((p) => [p.name, p.type, p.temporality, p.monotonic])).toEqual([
      ['g', 'gauge', 'unspecified', false],
      ['s', 'sum', 'delta', true],
      ['h', 'histogram', 'cumulative', false],
      ['e', 'exponentialHistogram', 'cumulative', false],
      ['q', 'summary', 'unspecified', false],
    ]);
    expect(pts[0]).toMatchObject({ start: null, time: 100, flags: 1, point: { asDouble: 2.5 } });
    expect(pts[0]?.attributes.get('a')).toEqual({ kind: 'string', value: 'x' });
    expect(pts[1]?.start).toBe(0);
    expect(pts[1]?.point).toEqual({
      asInt: '9007199254740993',
      exemplars: [{ timeUnixNano: t, asDouble: 1, traceId: TRACE_ID, spanId: SPAN_ID }],
    });
    expect(pts[2]?.point).toEqual({ count: '3', sum: 6, bucketCounts: ['1', '2'], explicitBounds: [1] });
    expect(JSON.stringify(pts.map((p) => p.point))).toContain('"quantile":0.5');
  });
});

describe('normalizeMetrics: number points', () => {
  const T = BigInt(T0);
  const request = (points: NumberDataPoint[]) =>
    create(ExportMetricsServiceRequestSchema, {
      resourceMetrics: [
        {
          scopeMetrics: [
            { metrics: [{ name: 'g', data: { case: 'gauge', value: { dataPoints: points } } }] },
          ],
        },
      ],
    });
  /** The point JSON as it was built before the direct path: protobuf `toJson` less the record-level fields. */
  const viaToJson = (dp: NumberDataPoint): JsonObject => {
    const {
      attributes: _a,
      startTimeUnixNano: _s,
      timeUnixNano: _t,
      flags: _f,
      ...rest
    } = toJson(NumberDataPointSchema, dp) as JsonObject;
    return rest;
  };

  test('point JSON built straight from the message equals protobuf toJson at the edges', () => {
    const values: NumberDataPoint['value'][] = [
      { case: 'asInt', value: 0n },
      { case: 'asInt', value: -1n },
      { case: 'asInt', value: 2n ** 63n - 1n },
      { case: 'asInt', value: -(2n ** 63n) },
      { case: 'asDouble', value: 0 },
      { case: 'asDouble', value: -0 },
      { case: 'asDouble', value: 1.5 },
      { case: 'asDouble', value: Number.MAX_VALUE },
      { case: 'asDouble', value: Number.MIN_VALUE },
      { case: 'asDouble', value: Number.NaN },
      { case: 'asDouble', value: Number.POSITIVE_INFINITY },
      { case: 'asDouble', value: Number.NEGATIVE_INFINITY },
      { case: undefined },
    ];
    const kv = create(KeyValueSchema, {
      key: 'k',
      value: create(AnyValueSchema, { value: { case: 'intValue', value: 1n } }),
    });
    const points = values.flatMap((value, i) => [
      create(NumberDataPointSchema, { timeUnixNano: T + BigInt(i), value }),
      create(NumberDataPointSchema, {
        timeUnixNano: T,
        startTimeUnixNano: T,
        flags: 1,
        attributes: [kv],
        value,
      }),
    ]);
    const records = normalizeMetrics(request(points), createNormalizeContext(epoch), 'f');
    expect(records).toHaveLength(points.length);
    records.forEach((r, i) => {
      const want = viaToJson(points[i] as NumberDataPoint);
      expect(JSON.stringify(r.point)).toBe(JSON.stringify(want));
      expect(r.point).toStrictEqual(want); // -0 stays -0
    });
    // With exemplars the general path runs: field order follows the field numbers, ids are hex.
    const withExemplar = create(NumberDataPointSchema, {
      timeUnixNano: T,
      value: { case: 'asInt', value: 7n },
      exemplars: [
        { timeUnixNano: T, value: { case: 'asDouble', value: 1 }, spanId: new Uint8Array(8).fill(1) },
      ],
    });
    const [r] = normalizeMetrics(request([withExemplar]), createNormalizeContext(epoch), 'f');
    expect(JSON.stringify(r?.point)).toBe(
      `{"exemplars":[{"timeUnixNano":"${T0}","asDouble":1,"spanId":"0101010101010101"}],"asInt":"7"}`,
    );
  });

  test('times shared by neighbouring points convert once and still fail at the right point', () => {
    const at = (t: bigint, start = 0n) =>
      create(NumberDataPointSchema, {
        timeUnixNano: t,
        startTimeUnixNano: start,
        value: { case: 'asInt', value: 1n },
      });
    const ok = normalizeMetrics(
      request([at(T + 5n), at(T + 5n, T), at(T + 9n, T), at(T + 5n), at(T + 5n, T + 1n)]),
      createNormalizeContext(epoch),
      'f',
    );
    expect(ok.map((p) => [p.start, p.time])).toEqual([
      [null, 5],
      [0, 5],
      [0, 9],
      [null, 5],
      [1, 5],
    ]);
    const far = T + 2n ** 60n;
    for (const [points, field] of [
      [[at(T), at(T), at(far)], 'timeUnixNano'],
      [[at(T, T), at(T, T), at(T, far)], 'startTimeUnixNano'],
    ] as const) {
      expect(() => normalizeMetrics(request([...points]), createNormalizeContext(epoch), 'f')).toThrowError(
        expect.objectContaining({
          path: `f: resourceMetrics[0].scopeMetrics[0].metrics[0].gauge.dataPoints[2].${field}`,
        }),
      );
    }
  });
});

describe('normalizeMetrics: point JSON of every kind equals protobuf toJson', () => {
  const T = BigInt(T0);
  const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  /** The oracle: `toJson` without the record-level fields, exemplar ids replaced by hex ones at the end. */
  function oracle<D extends DescMessage>(schema: D, dp: MessageShape<D>): JsonObject {
    const exemplars = (dp as { exemplars?: Exemplar[] }).exemplars ?? [];
    const hexIds = (e: JsonValue, i: number): JsonValue => {
      if (typeof e !== 'object' || e === null || Array.isArray(e)) return e;
      const src = exemplars[i];
      const kept = Object.entries(e).filter(([k]) => k !== 'traceId' && k !== 'spanId');
      if (src !== undefined && src.traceId.length > 0) kept.push(['traceId', hex(src.traceId)]);
      if (src !== undefined && src.spanId.length > 0) kept.push(['spanId', hex(src.spanId)]);
      return Object.fromEntries(kept);
    };
    const recordLevel = new Set(['attributes', 'startTimeUnixNano', 'timeUnixNano', 'flags']);
    return Object.fromEntries(
      Object.entries(toJson(schema, dp) as JsonObject)
        .filter(([k]) => !recordLevel.has(k))
        .map(([k, v]): [string, JsonValue] => [k, k === 'exemplars' && Array.isArray(v) ? v.map(hexIds) : v]),
    );
  }
  const doubles = [
    0,
    -0,
    1.5,
    -2.25,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  const kv = (key: string, value: Parameters<typeof create<typeof AnyValueSchema>>[1]) =>
    create(KeyValueSchema, { key, ...(value === undefined ? {} : { value: create(AnyValueSchema, value) }) });
  const attributes = [
    kv('s', { value: { case: 'stringValue', value: '' } }),
    kv('s2', { value: { case: 'stringValue', value: 'x</script> ' } }),
    kv('b', { value: { case: 'boolValue', value: false } }),
    kv('i', { value: { case: 'intValue', value: 0n } }),
    kv('i2', { value: { case: 'intValue', value: -(2n ** 63n) } }),
    kv('d', { value: { case: 'doubleValue', value: -0 } }),
    kv('d2', { value: { case: 'doubleValue', value: Number.NaN } }),
    kv('by', { value: { case: 'bytesValue', value: new Uint8Array([0, 1, 254, 255]) } }),
    kv('by0', { value: { case: 'bytesValue', value: new Uint8Array() } }),
    kv('a0', { value: { case: 'arrayValue', value: { values: [] } } }),
    kv('a', {
      value: {
        case: 'arrayValue',
        value: {
          values: [
            create(AnyValueSchema, {}),
            create(AnyValueSchema, { value: { case: 'kvlistValue', value: { values: [] } } }),
            create(AnyValueSchema, {
              value: {
                case: 'kvlistValue',
                value: { values: [kv('', { value: { case: 'intValue', value: 7n } }), kv('k', undefined)] },
              },
            }),
          ],
        },
      },
    }),
    kv('', undefined),
    kv('empty', {}),
  ];
  const exemplars: Exemplar[] = [
    create(ExemplarSchema, {}),
    create(ExemplarSchema, { timeUnixNano: T, value: { case: 'asDouble', value: -0 } }),
    create(ExemplarSchema, {
      timeUnixNano: 0n,
      value: { case: 'asInt', value: 0n },
      spanId: new Uint8Array(8).fill(1),
    }),
    create(ExemplarSchema, {
      timeUnixNano: T + 1n,
      value: { case: 'asDouble', value: Number.NaN },
      traceId: new Uint8Array(16).fill(2),
      spanId: new Uint8Array(8).fill(3),
      filteredAttributes: attributes,
    }),
    create(ExemplarSchema, {
      value: { case: 'asInt', value: 2n ** 63n - 1n },
      traceId: new Uint8Array(16).fill(4),
    }),
  ];

  function check<D extends DescMessage>(
    schema: D,
    kind: 'gauge' | 'histogram' | 'exponentialHistogram' | 'summary',
    points: MessageShape<D>[],
  ): void {
    // Points go through the request as the writer sees them: a `create`d request (the API path).
    const req = create(ExportMetricsServiceRequestSchema, {
      resourceMetrics: [
        {
          scopeMetrics: [
            { metrics: [{ name: kind, data: { case: kind, value: { dataPoints: points as never } } }] },
          ],
        },
      ],
    });
    const records = normalizeMetrics(req, createNormalizeContext(epoch), 'f');
    expect(records).toHaveLength(points.length);
    records.forEach((r, i) => {
      const want = oracle(schema, points[i] as MessageShape<D>);
      expect(JSON.stringify(r.point)).toBe(JSON.stringify(want));
      expect(r.point).toStrictEqual(want); // -0 stays -0
    });
  }

  test('number points with exemplars', () => {
    check(NumberDataPointSchema, 'gauge', [
      create(NumberDataPointSchema, { timeUnixNano: T, exemplars }),
      create(NumberDataPointSchema, { timeUnixNano: T, value: { case: 'asDouble', value: 0 }, exemplars }),
      create(NumberDataPointSchema, {
        timeUnixNano: T,
        value: { case: 'asInt', value: 0n },
        exemplars: [exemplars[3] as Exemplar],
      }),
    ]);
  });

  test('histogram points', () => {
    check(HistogramDataPointSchema, 'histogram', [
      create(HistogramDataPointSchema, { timeUnixNano: T }),
      create(HistogramDataPointSchema, { timeUnixNano: T, count: 0n, sum: 0, min: -0, max: 0 }),
      ...doubles.map((d) =>
        create(HistogramDataPointSchema, {
          timeUnixNano: T,
          count: 2n ** 64n - 1n,
          sum: d,
          bucketCounts: [0n, 1n, 2n ** 64n - 1n],
          explicitBounds: [d, ...doubles],
          exemplars,
          min: d,
          max: -d,
        }),
      ),
    ]);
  });

  test('exponential histogram points', () => {
    check(ExponentialHistogramDataPointSchema, 'exponentialHistogram', [
      create(ExponentialHistogramDataPointSchema, { timeUnixNano: T }),
      create(ExponentialHistogramDataPointSchema, {
        timeUnixNano: T,
        positive: {},
        negative: { offset: 0, bucketCounts: [] },
      }),
      create(ExponentialHistogramDataPointSchema, { timeUnixNano: T, scale: -10, zeroThreshold: -0, sum: 0 }),
      ...doubles.map((d, i) =>
        create(ExponentialHistogramDataPointSchema, {
          timeUnixNano: T,
          count: BigInt(i),
          sum: d,
          scale: i - 4,
          zeroCount: 2n ** 64n - BigInt(i),
          positive: { offset: -(2 ** 31), bucketCounts: [1n, 0n] },
          negative: { offset: 2 ** 31 - 1, bucketCounts: [3n] },
          exemplars,
          min: d,
          max: d,
          zeroThreshold: d,
        }),
      ),
    ]);
  });

  test('summary points', () => {
    check(SummaryDataPointSchema, 'summary', [
      create(SummaryDataPointSchema, { timeUnixNano: T }),
      create(SummaryDataPointSchema, {
        timeUnixNano: T,
        sum: -0,
        quantileValues: [{ quantile: 0, value: 0 }],
      }),
      ...doubles.map((d) =>
        create(SummaryDataPointSchema, {
          timeUnixNano: T,
          count: 3n,
          sum: d,
          quantileValues: doubles.map((q) => ({ quantile: q, value: d })),
        }),
      ),
    ]);
  });
});

describe('earliestTimestamp', () => {
  test('returns the earliest non-zero timestamp per signal, null when none', () => {
    expect(earliestTimestamp(only(traceRequest([span({ startTimeUnixNano: '77' })])))).toBe(77n);
    expect(
      earliestTimestamp(only(logsRequest([logRecord({ timeUnixNano: '0', observedTimeUnixNano: '5' })]))),
    ).toBe(5n);
    expect(earliestTimestamp(only(metricsRequest([gauge('g', [{ timeUnixNano: '9', asInt: '1' }])])))).toBe(
      9n,
    );
    expect(earliestTimestamp(only({ resourceSpans: [] }))).toBeNull();
  });

  test('is the minimum, not the first, and skips zero', () => {
    const spans = [
      span({ startTimeUnixNano: '0' }),
      span({ startTimeUnixNano: '900' }),
      span({ startTimeUnixNano: '300' }),
      span({ startTimeUnixNano: '500' }),
    ];
    expect(earliestTimestamp(only(traceRequest(spans)))).toBe(300n);
    const logs = [
      logRecord({ timeUnixNano: '50' }),
      logRecord({ timeUnixNano: '0', observedTimeUnixNano: '20' }),
    ];
    expect(earliestTimestamp(only(logsRequest(logs)))).toBe(20n);
    const points = [
      { timeUnixNano: '40', asInt: '1' },
      { timeUnixNano: '10', asInt: '1' },
    ];
    expect(earliestTimestamp(only(metricsRequest([gauge('g', points)])))).toBe(10n);
  });
});
