import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { ExportLogsServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import { type OtlpRequest, parseOtlpJson } from '../../src/model/otlp-json.js';
import { OtlpJsonStream } from '../../src/model/otlp-json-stream.js';
import { streamOtlpProtobuf } from '../../src/model/otlp-proto.js';
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

/**
 * Pushes `text` in pieces of `size` characters (whole when omitted), yielding requests as each piece completes them.
 */
function* streamOtlpJson(
  text: string,
  source: string,
  size = text.length,
  lines = false,
): Generator<OtlpRequest, void, undefined> {
  const stream = new OtlpJsonStream(source, { lines });
  for (let at = 0; at < text.length; at += Math.max(1, size)) yield* stream.push(text.slice(at, at + size));
  stream.end();
}

/** Three log resources and one trace resource, with a nested unknown top-level field between them. */
function mixed(): Record<string, unknown> {
  const resourceLogs = [0, 1, 2].flatMap((n) =>
    Object.values(
      logsRequest(
        [logRecord({ body: { stringValue: `log ${n} "]}{[" \\ \u2028 é😀` } })],
        [attr('service.name', { stringValue: `svc-${n}` })],
      ),
    ).flat(),
  );
  return {
    resourceLogs,
    unknown: { nested: [1, { deep: '"]' }], n: null },
    ...traceRequest([span()]),
  };
}

/** Requests merged per signal, in the shape `parseOtlpJson` returns, to compare the two parsers. */
function merged(reqs: readonly OtlpRequest[]): OtlpRequest[] {
  const out: OtlpRequest[] = [];
  for (const signal of ['traces', 'logs', 'metrics'] as const) {
    const mine = reqs.filter((r) => r.signal === signal);
    const [first, ...rest] = mine;
    if (first === undefined) continue;
    for (const r of rest) {
      if (first.signal === 'traces' && r.signal === 'traces')
        first.request.resourceSpans.push(...r.request.resourceSpans);
      if (first.signal === 'logs' && r.signal === 'logs')
        first.request.resourceLogs.push(...r.request.resourceLogs);
      if (first.signal === 'metrics' && r.signal === 'metrics')
        first.request.resourceMetrics.push(...r.request.resourceMetrics);
    }
    out.push(first);
  }
  return out;
}

const resources = (r: OtlpRequest): number => {
  switch (r.signal) {
    case 'traces':
      return r.request.resourceSpans.length;
    case 'logs':
      return r.request.resourceLogs.length;
    case 'metrics':
      return r.request.resourceMetrics.length;
  }
};

describe('streamOtlpJson', () => {
  test('yields one request per resource entry, in file order', () => {
    const reqs = [...streamOtlpJson(JSON.stringify(mixed()), 'a.json')];
    expect(reqs.map((r) => r.signal)).toEqual(['logs', 'logs', 'logs', 'traces']);
    expect(reqs.map(resources)).toEqual([1, 1, 1, 1]);
  });

  test('reads the same data as parseOtlpJson, compact or pretty-printed, in pieces of any size', () => {
    for (const text of [
      JSON.stringify(mixed()),
      JSON.stringify(mixed(), null, 2),
      ` \n${JSON.stringify(mixed())}\r\n`,
    ]) {
      for (const size of [undefined, 1, 2, 5, 64]) {
        expect(merged([...streamOtlpJson(text, 'a.json', size)]), String(size)).toEqual(
          parseOtlpJson(text, 'a.json'),
        );
      }
    }
  });

  test('keeps int64 numbers above 2^53 exact', () => {
    const text = `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"${TRACE_ID}","spanId":"${SPAN_ID}","startTimeUnixNano":1700000000000000001,"endTimeUnixNano":${T0},"attributes":[{"key":"big","value":{"intValue":9007199254740993}}]}]}]}],"resourceMetrics":[{"scopeMetrics":[{"metrics":[{"name":"h","histogram":{"dataPoints":[{"timeUnixNano":1700000000000000005,"count":18446744073709551615,"bucketCounts":[9007199254740993,1],"sum":100000000000000000000}]}}]}]}]}`;
    const reqs = [...streamOtlpJson(text, 'a.json')];
    expect(reqs).toEqual(parseOtlpJson(text, 'a.json'));
    expect([...streamOtlpJson(text, 'a.json', 3)]).toEqual(reqs);
    const [tr] = reqs;
    expect(
      tr?.signal === 'traces' && tr.request.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.startTimeUnixNano,
    ).toBe(1700000000000000001n);
  });

  test('error paths keep the resource index', () => {
    const obj = {
      resourceSpans: [
        ...Object.values(traceRequest([span()])).flat(),
        ...Object.values(traceRequest([span({ spanId: 'q' })])).flat(),
      ],
    };
    expect(() => [...streamOtlpJson(JSON.stringify(obj), 'a.json')]).toThrowError(
      /^a\.json: resourceSpans\[1\]\.scopeSpans\[0\]\.spans\[0\]\.spanId: expected 16 hex chars/,
    );
  });

  test('returns each request with the piece that completes it, before a later bad one is read', () => {
    const good = JSON.stringify(Object.values(logsRequest([logRecord()])).flat()[0]);
    const stream = new OtlpJsonStream('a.json', { lines: false });
    expect(stream.push('{"resourceLogs":[')).toEqual([]);
    expect(stream.push(`${good.slice(0, 10)}`)).toEqual([]);
    expect(stream.push(`${good.slice(10)},`).map((r) => r.signal)).toEqual(['logs']);
    expect(() => stream.push('{"scopeLogs":[{"logRecords":[{"traceId":"zz"}]}]}]}')).toThrowError(
      /^a\.json: resourceLogs\[1\]\.scopeLogs\[0\]\.logRecords\[0\]\.traceId/,
    );
  });

  test('an empty signal array yields one empty request, like parseOtlpJson', () => {
    expect([...streamOtlpJson('{"resourceSpans":[ ]}', 'a.json')]).toEqual(
      parseOtlpJson('{"resourceSpans":[]}', 'a.json'),
    );
  });

  test('a "__proto__" key stays inert data', () => {
    const text = `{"__proto__":{"polluted":1},${JSON.stringify(traceRequest([span()])).slice(1)}`;
    expect([...streamOtlpJson(text, 'a.json')]).toHaveLength(1);
    expect('polluted' in {}).toBe(false);
  });

  test('rejects malformed JSON as invalid-otlp naming the file', () => {
    const bad = [
      '',
      '{',
      '{"resourceSpans":[',
      '{"resourceSpans":[{}',
      '{"resourceSpans":[{}}',
      '{"resourceSpans":[{"a":1,}]}',
      '{"resourceSpans":[] "x":1}',
      '{"resourceSpans":[]}x',
      '{"resourceSpans" []}',
      '{resourceSpans:[]}',
      '{"unknown":[1,],"resourceSpans":[]}',
      '{"resourceSpans":["unterminated]}',
      '{"resourceSpans":[],"n":1',
      '{"resourceSpans":[{"a":"\\',
      'x',
    ];
    for (const [text, size] of bad.flatMap((t) =>
      [t, t, t].map((x, i) => [x, [undefined, 1, 3][i]] as const),
    )) {
      let error: unknown;
      try {
        for (const _ of streamOtlpJson(text, 'a.json', size));
      } catch (e) {
        error = e;
      }
      expect(error, text).toBeInstanceOf(OtelHtmlError);
      expect(error instanceof OtelHtmlError && error.code, text).toBe('invalid-otlp');
      expect(String(error), text).toMatch(/a\.json: invalid JSON/);
    }
  });

  test('rejects non-objects, objects without a signal and non-array signals like parseOtlpJson', () => {
    expect(() => [...streamOtlpJson('[]', 'a.json')]).toThrowError(
      /^a\.json: expected a JSON object, got array/,
    );
    expect(() => [...streamOtlpJson('{"foo":{"resourceSpans":[]}}', 'a.json')]).toThrowError(
      /^a\.json: expected at least one of resourceSpans, resourceLogs or resourceMetrics/,
    );
    expect(() => [...streamOtlpJson('{}', 'a.json')]).toThrowError(/^a\.json: expected at least one of/);
    expect(() => [...streamOtlpJson('{"resourceSpans":{}}', 'a.json')]).toThrowError(
      /^a\.json: resourceSpans: expected array, got object/,
    );
  });
});

describe('several documents (JSON lines)', () => {
  const text = [
    JSON.stringify(mixed()),
    '',
    `${JSON.stringify(metricsRequest([gauge('g', [{ timeUnixNano: T0, asInt: '3' }])]))}\r`,
    JSON.stringify(traceRequest([span({ spanId: 'q' })])),
  ].join('\n');

  test('streams every resource of every line; errors name the 1-based line', () => {
    for (const lines of [true, false]) {
      const seen: string[] = [];
      expect(() => {
        for (const r of streamOtlpJson(text, 'out.jsonl', 7, lines)) seen.push(r.signal);
      }).toThrowError(/^out\.jsonl:4: resourceSpans\[0\]\.scopeSpans\[0\]\.spans\[0\]\.spanId/);
      expect(seen).toEqual(['logs', 'logs', 'logs', 'traces', 'metrics']);
    }
  });

  test('without lines, the first document is named after the source alone', () => {
    expect(() => [...streamOtlpJson('{}\n{}', 'a.json')]).toThrowError(/^a\.json: expected at least one of/);
    expect(() => [...streamOtlpJson('{}\n{}', 'a.jsonl', undefined, true)]).toThrowError(
      /^a\.jsonl:1: expected at least one of/,
    );
    expect(() => [...streamOtlpJson('{"resourceSpans":[]}\n\n{}', 'a.json')]).toThrowError(
      /^a\.json:3: expected at least one of/,
    );
  });

  test('an input without documents is valid only as JSON lines', () => {
    expect([...streamOtlpJson(' \n', 'a.jsonl', undefined, true)]).toEqual([]);
    expect(() => [...streamOtlpJson(' \n', 'a.json')]).toThrowError(/^a\.json: invalid JSON/);
  });
});

describe('streamOtlpProtobuf', () => {
  const bin = toBinary(
    ExportLogsServiceRequestSchema,
    create(ExportLogsServiceRequestSchema, {
      resourceLogs: [1n, 2n, 3n].map((n) => ({
        scopeLogs: [{ logRecords: [{ timeUnixNano: 1700000000000000000n + n, severityText: 'x' }] }],
      })),
    }),
  );

  test('yields one request per resource entry, in order', () => {
    const reqs = [...streamOtlpProtobuf(bin, 'logs', 'a.pb')];
    expect(reqs.map(resources)).toEqual([1, 1, 1]);
    expect(
      reqs.map((r) =>
        r.signal === 'logs' ? r.request.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.timeUnixNano : null,
      ),
    ).toEqual([1700000000000000001n, 1700000000000000002n, 1700000000000000003n]);
  });

  test('an empty message yields one empty request', () => {
    const reqs = [...streamOtlpProtobuf(new Uint8Array(), 'traces', 'a.pb')];
    expect(reqs.map((r) => [r.signal, resources(r)])).toEqual([['traces', 0]]);
  });

  test('rejects garbage and truncation as invalid-otlp with the source', () => {
    expect(() => [...streamOtlpProtobuf(new Uint8Array([0xff, 0xff, 0xff]), 'traces', 'a.pb')]).toThrowError(
      /^a\.pb: invalid OTLP protobuf \(traces\)/,
    );
    expect(() => [...streamOtlpProtobuf(bin.subarray(0, bin.length - 3), 'logs', 'a.pb')]).toThrowError(
      /^a\.pb: invalid OTLP protobuf \(logs\)/,
    );
  });
});
