import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it, test, vi } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import {
  type ExportLogsServiceRequest,
  ExportLogsServiceRequestSchema,
} from '../../src/model/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import type { ExportMetricsServiceRequest } from '../../src/model/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import type { ExportTraceServiceRequest } from '../../src/model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import { parseUnixNanos } from '../../src/model/ids.js';
import { parseJsonLines } from '../../src/model/jsonl.js';
import {
  createNormalizeContext,
  normalizeLogs,
  normalizeMetrics,
  normalizeTraces,
} from '../../src/model/normalize.js';
import { type OtlpRequest, parseOtlpJson, parseOtlpObject } from '../../src/model/otlp-json.js';
import { parseOtlpProtobuf } from '../../src/model/otlp-proto.js';
import { SpanKind } from '../../src/model/records.js';
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

const newCtx = createNormalizeContext;
const epoch = parseUnixNanos(T0, 'epoch');

function traces(r: OtlpRequest | undefined): ExportTraceServiceRequest {
  if (r?.signal !== 'traces') throw new Error(`expected traces, got ${r?.signal}`);
  return r.request;
}
function logs(r: OtlpRequest | undefined): ExportLogsServiceRequest {
  if (r?.signal !== 'logs') throw new Error(`expected logs, got ${r?.signal}`);
  return r.request;
}
function metrics(r: OtlpRequest | undefined): ExportMetricsServiceRequest {
  if (r?.signal !== 'metrics') throw new Error(`expected metrics, got ${r?.signal}`);
  return r.request;
}
function oneSpan(json: unknown) {
  const [req] = parseOtlpJson(JSON.stringify(json), 'run.json');
  const [s] = normalizeTraces(traces(req), newCtx(epoch), 'run.json');
  if (s === undefined) throw new Error('no span');
  return s;
}

test('runtime exposes JSON.parse reviver source text (required for int64 precision)', () => {
  expect(typeof JSON.parse('1', (_k: string, _v: unknown, c?: { source?: string }) => c?.source)).toBe(
    'string',
  );
});

describe('parseOtlpJson', () => {
  test('accepts int64 as string or number without precision loss', () => {
    const text =
      '{"resourceSpans":[{"resource":{},"scopeSpans":[{"scope":{},"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"a","kind":2,"startTimeUnixNano":1700000000000000001,"endTimeUnixNano":"1700000000000000999"}]}]}]}';
    const [req] = parseOtlpJson(text, 'run.json');
    const ctx = newCtx(parseUnixNanos('1700000000000000000', 'e'));
    const [s] = normalizeTraces(traces(req), ctx, 'run.json');
    expect(s?.start).toBe(1);
    expect(s?.end).toBe(999);
    expect(traces(req).resourceSpans[0]?.scopeSpans[0]?.spans[0]?.startTimeUnixNano).toBe(
      1700000000000000001n,
    );
  });

  test('int64 numbers above 2^53 survive in every int64 field kind', () => {
    const text = `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"${TRACE_ID}","spanId":"${SPAN_ID}","startTimeUnixNano":${T0},"endTimeUnixNano":${T0},"attributes":[{"key":"big","value":{"intValue":9007199254740993}},{"key":"arr","value":{"arrayValue":{"values":[{"intValue":-9223372036854775807}]}}}],"events":[{"timeUnixNano":1700000000000000003,"name":"e"}]}]}]}],"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":"h","histogram":{"aggregationTemporality":2,"dataPoints":[{"timeUnixNano":1700000000000000005,"count":18446744073709551615,"bucketCounts":[9007199254740993,1],"explicitBounds":[1.5],"sum":100000000000000000000,"exemplars":[{"timeUnixNano":1700000000000000007,"asInt":9007199254740995}]}]}},{"name":"g","gauge":{"dataPoints":[{"timeUnixNano":1700000000000000009,"asInt":-9007199254740997}]}}]}]}]}`;
    const [tr, mr] = parseOtlpJson(text, 'run.json');
    const sp = traces(tr).resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(sp?.startTimeUnixNano).toBe(1700000000000000000n);
    expect(sp?.attributes[0]?.value?.value).toEqual({ case: 'intValue', value: 9007199254740993n });
    const arr = sp?.attributes[1]?.value?.value;
    expect(arr?.case === 'arrayValue' && arr.value.values[0]?.value.value).toBe(-9223372036854775807n);
    expect(sp?.events[0]?.timeUnixNano).toBe(1700000000000000003n);
    const ms = metrics(mr).resourceMetrics[0]?.scopeMetrics[0]?.metrics;
    const h = ms?.[0]?.data;
    if (h?.case !== 'histogram') throw new Error('expected histogram');
    const dp = h.value.dataPoints[0];
    expect(dp?.timeUnixNano).toBe(1700000000000000005n);
    expect(dp?.count).toBe(18446744073709551615n);
    expect(dp?.bucketCounts).toEqual([9007199254740993n, 1n]);
    expect(dp?.explicitBounds).toEqual([1.5]);
    expect(dp?.sum).toBe(1e20);
    expect(dp?.exemplars[0]?.timeUnixNano).toBe(1700000000000000007n);
    expect(dp?.exemplars[0]?.value).toEqual({ case: 'asInt', value: 9007199254740995n });
    const g = ms?.[1]?.data;
    if (g?.case !== 'gauge') throw new Error('expected gauge');
    expect(g.value.dataPoints[0]?.value).toEqual({ case: 'asInt', value: -9007199254740997n });
  });

  test('integer enums, unknown fields ignored, hex ids', () => {
    const s = oneSpan(
      traceRequest([
        span({
          kind: 2,
          foo: 'bar',
          // biome-ignore lint/correctness/noPrecisionLoss: an unsafe literal inside an unknown field must be ignored
          nested: { x: [1, 2, 99999999999999999999] },
          traceId: TRACE_ID.toUpperCase(),
        }),
      ]),
    );
    expect(s.kind).toBe(SpanKind.SERVER);
    expect(s.traceId).toBe(TRACE_ID);
    expect(s.spanId).toBe(SPAN_ID);
    expect(s.parentSpanId).toBeNull();
  });

  test('rejects bad input with a precise path', () => {
    expect(() =>
      parseOtlpJson('{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"zz"}]}]}]}', 'run.json'),
    ).toThrowError(
      /run\.json: resourceSpans\[0\]\.scopeSpans\[0\]\.spans\[0\]\.traceId: expected 32 hex chars/,
    );
    expect(() =>
      parseOtlpJson(JSON.stringify(traceRequest([span(), span({ parentSpanId: 'abc' })])), 'run.json'),
    ).toThrowError(
      /run\.json: resourceSpans\[0\]\.scopeSpans\[0\]\.spans\[1\]\.parentSpanId: expected 16 hex chars/,
    );
    expect(() =>
      parseOtlpJson(
        JSON.stringify(traceRequest([span({ links: [{ traceId: TRACE_ID, spanId: 'nothex!!nothex!!' }] })])),
        'run.json',
      ),
    ).toThrowError(/spans\[0\]\.links\[0\]\.spanId: expected 16 hex chars/);
    expect(() =>
      parseOtlpJson(JSON.stringify(logsRequest([logRecord({ traceId: 'abc' })])), 'run.json'),
    ).toThrowError(
      /run\.json: resourceLogs\[0\]\.scopeLogs\[0\]\.logRecords\[0\]\.traceId: expected 32 hex chars/,
    );
    expect(() =>
      parseOtlpJson(
        JSON.stringify(
          metricsRequest([gauge('g', [{ timeUnixNano: T0, asDouble: 1, exemplars: [{ spanId: 'x' }] }])]),
        ),
        'run.json',
      ),
    ).toThrowError(
      /resourceMetrics\[0\]\.scopeMetrics\[0\]\.metrics\[0\]\.gauge\.dataPoints\[0\]\.exemplars\[0\]\.spanId: expected 16 hex chars/,
    );
    expect(() => parseOtlpJson('{"resourceSpans":{}}', 'run.json')).toThrowError(
      /run\.json: resourceSpans: expected array, got object/,
    );
  });

  test('protobuf-es errors are re-thrown as invalid-otlp with the source prefixed', () => {
    const run = (): unknown => parseOtlpJson(JSON.stringify(traceRequest([span({ name: 5 })])), 'run.json');
    expect(run).toThrowError(OtelHtmlError);
    expect(run).toThrowError(/^run\.json: .*name.*expected string/);
    try {
      run();
    } catch (e) {
      expect(e instanceof OtelHtmlError && e.code).toBe('invalid-otlp');
    }
  });

  test('rejects invalid JSON, non-objects and objects without a signal', () => {
    expect(() => parseOtlpJson('{"resourceSpans":[', 'a.json')).toThrowError(/^a\.json: invalid JSON/);
    expect(() => parseOtlpJson('[]', 'a.json')).toThrowError(/^a\.json: expected a JSON object/);
    expect(() => parseOtlpJson('{"foo":1}', 'a.json')).toThrowError(
      /^a\.json: expected .*resourceSpans, resourceLogs or resourceMetrics/,
    );
  });

  test('an object may hold several signals; order is traces, logs, metrics', () => {
    const obj = {
      ...metricsRequest([gauge('g', [{ timeUnixNano: T0, asDouble: 1 }])]),
      ...logsRequest([logRecord()]),
      ...traceRequest([span()]),
    };
    expect(parseOtlpJson(JSON.stringify(obj), 'a.json').map((r) => r.signal)).toEqual([
      'traces',
      'logs',
      'metrics',
    ]);
    expect(parseOtlpJson('{"resourceSpans":[]}', 'a.json')).toHaveLength(1);
  });

  test('AnyValue kinds survive: kvlist, array, bytes, int, double, empty', () => {
    const s = oneSpan(
      traceRequest([
        span({
          attributes: [
            attr('kv', { kvlistValue: { values: [attr('inner', { boolValue: true })] } }),
            attr('arr', { arrayValue: { values: [{ stringValue: 'x' }, { doubleValue: 2.5 }, {}] } }),
            attr('bytes', { bytesValue: 'AQID' }),
            attr('int', { intValue: '42' }),
            attr('double', { doubleValue: 1.25 }),
            attr('nan', { doubleValue: 'NaN' }),
            attr('empty', {}),
            attr('missing', null),
          ],
        }),
      ]),
    );
    expect(s.attributes.get('kv')).toEqual({
      kind: 'kvlist',
      values: new Map([['inner', { kind: 'bool', value: true }]]),
    });
    expect(s.attributes.get('arr')).toEqual({
      kind: 'array',
      values: [{ kind: 'string', value: 'x' }, { kind: 'double', value: 2.5 }, { kind: 'empty' }],
    });
    expect(s.attributes.get('bytes')).toEqual({ kind: 'bytes', value: new Uint8Array([1, 2, 3]) });
    expect(s.attributes.get('int')).toEqual({ kind: 'int', value: 42n });
    expect(s.attributes.get('double')).toEqual({ kind: 'double', value: 1.25 });
    expect(s.attributes.get('nan')).toEqual({ kind: 'double', value: Number.NaN });
    expect(s.attributes.get('empty')).toEqual({ kind: 'empty' });
    expect(s.attributes.get('missing')).toEqual({ kind: 'empty' });
  });

  test('hostile strings pass through untouched', () => {
    const hostile = [
      '</script><script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      'line\nbreak\r\n\ttab',
      '\u0000nul  ',
      '‮rtl override',
      '"quotes" \'single\' `back` \\',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: hostile literal on purpose
      '${template} {{mustache}}',
      '😀 emoji',
      '   leading and trailing   ',
      '',
    ];
    for (const h of hostile) {
      const s = oneSpan(
        traceRequest([
          span({
            name: h,
            traceState: h,
            attributes: [attr(h || 'k', { stringValue: h }), attr('__proto__', { stringValue: h })],
            status: { code: 2, message: h },
          }),
        ]),
      );
      expect(s.name).toBe(h);
      expect(s.traceState).toBe(h);
      expect(s.status.message).toBe(h);
      expect(s.attributes.get(h || 'k')).toEqual({ kind: 'string', value: h });
      expect(s.attributes.get('__proto__')).toEqual({ kind: 'string', value: h });
    }
  });

  test('a "__proto__" unknown field is ignored and does not pollute prototypes', () => {
    const text = `{"__proto__":{"polluted":1},"resourceSpans":[{"scopeSpans":[{"spans":[{"__proto__":5,"traceId":"${TRACE_ID}","spanId":"${SPAN_ID}","startTimeUnixNano":${T0},"endTimeUnixNano":${T0}}]}]}]}`;
    const s = oneSpan(JSON.parse(text));
    expect(s.spanId).toBe(SPAN_ID);
    expect(parseOtlpJson(text, 'a.json')).toHaveLength(1);
    expect('polluted' in {}).toBe(false);
  });
});

describe('parseJsonLines', () => {
  test('collector file-exporter JSON lines with mixed signals', () => {
    const text = [
      JSON.stringify(traceRequest([span()])),
      '',
      JSON.stringify(logsRequest([logRecord()])),
      `${JSON.stringify(metricsRequest([gauge('g', [{ timeUnixNano: T0, asInt: '3' }])]))}\r`,
      '',
    ].join('\n');
    const reqs = parseJsonLines(text, 'out.jsonl');
    expect(reqs.map((r) => r.signal)).toEqual(['traces', 'logs', 'metrics']);
    expect(normalizeTraces(traces(reqs[0]), newCtx(epoch), 'out.jsonl')).toHaveLength(1);
    expect(normalizeLogs(logs(reqs[1]), newCtx(epoch), 'out.jsonl')).toHaveLength(1);
    expect(normalizeMetrics(metrics(reqs[2]), newCtx(epoch), 'out.jsonl')).toHaveLength(1);
  });

  test('errors carry the 1-based line number', () => {
    const text = `${JSON.stringify(traceRequest([span()]))}\n${JSON.stringify(traceRequest([span({ spanId: 'q' })]))}\n`;
    expect(() => parseJsonLines(text, 'out.jsonl')).toThrowError(
      /^out\.jsonl:2: resourceSpans\[0\]\.scopeSpans\[0\]\.spans\[0\]\.spanId: expected 16 hex chars/,
    );
    expect(() => parseJsonLines('{}\n{', 'out.jsonl')).toThrowError(/^out\.jsonl:1: expected/);
    expect(() => parseJsonLines('{"resourceSpans":[]}\n{', 'out.jsonl')).toThrowError(
      /^out\.jsonl:2: invalid JSON/,
    );
  });
});

describe('parseOtlpProtobuf', () => {
  it('decodes binary requests', () => {
    const bin = toBinary(
      ExportLogsServiceRequestSchema,
      create(ExportLogsServiceRequestSchema, {
        resourceLogs: [
          { scopeLogs: [{ logRecords: [{ timeUnixNano: 1700000000000000001n, severityText: 'x' }] }] },
        ],
      }),
    );
    const req = parseOtlpProtobuf(bin, 'logs', 'a.pb');
    expect(req.signal).toBe('logs');
    expect(logs(req).resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.timeUnixNano).toBe(1700000000000000001n);
  });
  it('rejects garbage as invalid-otlp with the source', () => {
    expect(() => parseOtlpProtobuf(new Uint8Array([0xff, 0xff, 0xff]), 'traces', 'a.pb')).toThrowError(
      /^a\.pb: invalid OTLP protobuf \(traces\)/,
    );
  });
});

describe('parseOtlpObject', () => {
  it('accepts a parsed object and yields the same requests as the text path', () => {
    const json = traceRequest([span()], [attr('service.name', { stringValue: 'svc' })]);
    expect(parseOtlpObject(json, 'obj')).toEqual(parseOtlpJson(JSON.stringify(json), 'obj'));
  });
  it('keeps int64 strings exact', () => {
    const json = traceRequest([span({ startTimeUnixNano: '1700000000000000001' })]);
    const [req] = parseOtlpObject(json, 'obj');
    expect(traces(req).resourceSpans[0]?.scopeSpans[0]?.spans[0]?.startTimeUnixNano).toBe(
      1700000000000000001n,
    );
  });
  it('rejects a lossy number in an int64 field instead of silently rounding', () => {
    const json = traceRequest([span({ startTimeUnixNano: Number('1700000000000000001') })]);
    expect(() => parseOtlpObject(json, 'obj')).toThrowError(
      /^obj: resourceSpans\[0\]\.scopeSpans\[0\]\.spans\[0\]\.startTimeUnixNano: expected an exact integer/,
    );
  });
  it('rejects a lossy number inside an int64 array', () => {
    const json = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'h',
                  histogram: { dataPoints: [{ bucketCounts: ['1', Number('1700000000000000001')] }] },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => parseOtlpObject(json, 'obj')).toThrowError(/bucketCounts\[1\]: expected an exact integer/);
  });
  it('rejects non-objects and objects without a signal', () => {
    expect(() => parseOtlpObject([], 'obj')).toThrowError(/^obj: expected a JSON object, got array/);
    expect(() => parseOtlpObject({}, 'obj')).toThrowError(/^obj: expected at least one of/);
  });
});

describe('int64 source text', () => {
  it('only integral unsafe numbers need source text; fractions pass through', () => {
    const original = JSON.parse;
    const spy = vi
      .spyOn(JSON, 'parse')
      .mockImplementation((text: string, reviver?: unknown) =>
        typeof reviver === 'function'
          ? original(text, (k: string, v: unknown) => reviver(k, v))
          : original(text),
      );
    try {
      const text = JSON.stringify(traceRequest([span({ attributes: [attr('f', { doubleValue: 1.5 })] })]));
      expect(parseOtlpJson(text, 'a.json')).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('fails explicitly when JSON.parse gives no source text', () => {
    const original = JSON.parse;
    const spy = vi
      .spyOn(JSON, 'parse')
      .mockImplementation((text: string, reviver?: unknown) =>
        typeof reviver === 'function'
          ? original(text, (k: string, v: unknown) => reviver(k, v))
          : original(text),
      );
    try {
      const text = `{"resourceSpans":[{"scopeSpans":[{"spans":[{"startTimeUnixNano":1700000000000000001}]}]}]}`;
      expect(() => parseOtlpJson(text, 'a.json')).toThrowError(/a\.json: .*source text/);
    } finally {
      spy.mockRestore();
    }
  });
});
