import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { readOtlpFile } from '../../src/model/detect.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { ExportTraceServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import {
  gauge,
  logRecord,
  logsRequest,
  metricsRequest,
  span,
  traceRequest,
} from '../../test-support/otlp-builders.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const signals = (r: readonly { signal: string }[]): string[] => r.map((x) => x.signal);

describe('readOtlpFile', () => {
  test('plain JSON, including pretty-printed and BOM-prefixed', () => {
    const obj = traceRequest([span()]);
    expect(signals(readOtlpFile(enc(JSON.stringify(obj)), 'a.json'))).toEqual(['traces']);
    expect(signals(readOtlpFile(enc(`${JSON.stringify(obj, null, 2)}\n`), 'a.json'))).toEqual(['traces']);
    expect(signals(readOtlpFile(enc(`﻿${JSON.stringify(obj)}`), 'a.json'))).toEqual(['traces']);
  });

  test('a malformed pretty-printed JSON file reports JSON errors, not line errors', () => {
    expect(() => readOtlpFile(enc('{\n  "resourceSpans": [\n'), 'a.json')).toThrowError(
      /^a\.json: invalid JSON/,
    );
  });

  test('.jsonl/.ndjson are JSON lines; several top-level objects are detected without the extension', () => {
    const lines = [
      JSON.stringify(traceRequest([span()])),
      JSON.stringify(logsRequest([logRecord()])),
      JSON.stringify(metricsRequest([gauge('g', [{ timeUnixNano: '1', asInt: '1' }])])),
    ].join('\n');
    for (const name of ['a.jsonl', 'a.ndjson', 'a.json', 'a.txt']) {
      expect(signals(readOtlpFile(enc(lines), name))).toEqual(['traces', 'logs', 'metrics']);
    }
    expect(signals(readOtlpFile(enc(JSON.stringify(traceRequest([span()]))), 'one.jsonl'))).toEqual([
      'traces',
    ]);
  });

  test('protobuf needs a signal hint', () => {
    const bin = toBinary(ExportTraceServiceRequestSchema, create(ExportTraceServiceRequestSchema));
    expect(signals(readOtlpFile(bin, 'a.pb', 'traces'))).toEqual(['traces']);
    expect(signals(readOtlpFile(bin, 'a.BINPB', 'traces'))).toEqual(['traces']);
    try {
      readOtlpFile(bin, 'a.pb');
      expect.unreachable();
    } catch (e) {
      expect(e instanceof OtelHtmlError && e.code).toBe('usage');
      expect(String(e)).toMatch(/a\.pb: expected a signal hint/);
      expect(String(e)).toMatch(/--signal/);
    }
  });

  test('gzip is rejected with a hint', () => {
    try {
      readOtlpFile(new Uint8Array([0x1f, 0x8b, 8, 0]), 'a.json.gz');
      expect.unreachable();
    } catch (e) {
      expect(e instanceof OtelHtmlError && e.code).toBe('unsupported-input');
      expect(String(e)).toMatch(/gunzip first/);
    }
  });
});
