import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { parseUnixNanos } from '../../src/model/ids.js';
import {
  createNormalizeContext,
  firstTimestamp,
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

describe('firstTimestamp', () => {
  test('returns the first non-zero timestamp per signal, null when none', () => {
    expect(firstTimestamp(only(traceRequest([span({ startTimeUnixNano: '77' })])))).toBe(77n);
    expect(
      firstTimestamp(only(logsRequest([logRecord({ timeUnixNano: '0', observedTimeUnixNano: '5' })]))),
    ).toBe(5n);
    expect(firstTimestamp(only(metricsRequest([gauge('g', [{ timeUnixNano: '9', asInt: '1' }])])))).toBe(9n);
    expect(firstTimestamp(only({ resourceSpans: [] }))).toBeNull();
  });
});
