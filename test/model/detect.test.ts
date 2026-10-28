import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { readOtlpFile } from '../../src/model/detect.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { ExportTraceServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import type { OtlpRequest } from '../../src/model/otlp-json.js';
import {
  attr,
  gauge,
  logRecord,
  logsRequest,
  metricsRequest,
  span,
  traceRequest,
} from '../../test-support/otlp-builders.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const signals = (r: readonly { signal: string }[]): string[] => r.map((x) => x.signal);

/** The bytes in pieces of `size` (whole when omitted), as a reader would hand them over. */
function pieces(bytes: Uint8Array, size = bytes.length): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += Math.max(1, size)) out.push(bytes.slice(at, at + size));
  return out;
}

async function read(
  bytes: Uint8Array,
  name: string,
  hint?: OtlpRequest['signal'],
  size?: number,
): Promise<OtlpRequest[]> {
  const out: OtlpRequest[] = [];
  for await (const r of readOtlpFile(pieces(bytes, size), name, hint)) out.push(r);
  return out;
}

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('readOtlpFile', () => {
  test('plain JSON, including pretty-printed and BOM-prefixed', async () => {
    const obj = traceRequest([span()]);
    expect(signals(await read(enc(JSON.stringify(obj)), 'a.json'))).toEqual(['traces']);
    expect(signals(await read(enc(`${JSON.stringify(obj, null, 2)}\n`), 'a.json'))).toEqual(['traces']);
    expect(signals(await read(enc(`﻿${JSON.stringify(obj)}`), 'a.json'))).toEqual(['traces']);
  });

  test('pieces of any size read the same, even mid-character and mid-escape', async () => {
    const text = `﻿${JSON.stringify(
      traceRequest([span({ name: 'é😀 "q" \\ ]}' })], [attr('service.name', { stringValue: 'ü' })]),
      null,
      1,
    )}`;
    const whole = await read(enc(text), 'a.json');
    for (const size of [1, 2, 3, 7, 61])
      expect(await read(enc(text), 'a.json', undefined, size)).toEqual(whole);
  });

  test('yields one request per resource entry', async () => {
    const two = {
      resourceLogs: [
        ...Object.values(logsRequest([logRecord()])).flat(),
        ...Object.values(logsRequest([logRecord()])).flat(),
      ],
    };
    expect(signals(await read(enc(JSON.stringify(two)), 'a.json', undefined, 5))).toEqual(['logs', 'logs']);
  });

  test('a malformed pretty-printed JSON file reports JSON errors, not line errors', async () => {
    await expect(read(enc('{\n  "resourceSpans": [\n'), 'a.json')).rejects.toThrowError(
      /^a\.json: invalid JSON/,
    );
  });

  test('.jsonl/.ndjson are JSON lines; several top-level objects are detected without the extension', async () => {
    const lines = [
      JSON.stringify(traceRequest([span()])),
      JSON.stringify(logsRequest([logRecord()])),
      JSON.stringify(metricsRequest([gauge('g', [{ timeUnixNano: '1', asInt: '1' }])])),
    ].join('\n');
    for (const name of ['a.jsonl', 'a.ndjson', 'a.json', 'a.txt']) {
      expect(signals(await read(enc(lines), name, undefined, 13))).toEqual(['traces', 'logs', 'metrics']);
    }
    expect(signals(await read(enc(JSON.stringify(traceRequest([span()]))), 'one.jsonl'))).toEqual(['traces']);
    expect(await read(enc('\n\n'), 'empty.jsonl')).toEqual([]);
    await expect(read(enc('\n\n'), 'empty.json')).rejects.toThrowError(/^empty\.json: invalid JSON/);
  });

  test('JSON lines errors name the line', async () => {
    const lines = `${JSON.stringify(traceRequest([span()]))}\n\n${JSON.stringify(traceRequest([span({ spanId: 'q' })]))}\n`;
    for (const name of ['a.jsonl', 'a.json']) {
      await expect(read(enc(lines), name)).rejects.toThrowError(
        new RegExp(
          `^${name.replace('.', '\\.')}:3: resourceSpans\\[0\\]\\.scopeSpans\\[0\\]\\.spans\\[0\\]\\.spanId`,
        ),
      );
    }
    await expect(read(enc('{"resourceSpans":[]}\n[]'), 'a.jsonl')).rejects.toThrowError(
      /^a\.jsonl:2: expected a JSON object, got array/,
    );
  });

  test('protobuf needs a signal hint', async () => {
    const bin = toBinary(
      ExportTraceServiceRequestSchema,
      create(ExportTraceServiceRequestSchema, { resourceSpans: [{}, {}] }),
    );
    expect(signals(await read(bin, 'a.pb', 'traces', 1))).toEqual(['traces', 'traces']);
    expect(signals(await read(bin, 'a.BINPB', 'traces'))).toEqual(['traces', 'traces']);
    const e = await failure(read(bin, 'a.pb'));
    expect(e.code).toBe('usage');
    expect(String(e)).toMatch(/a\.pb: expected a signal hint/);
    expect(String(e)).toMatch(/--signal/);
  });

  test('gzip is rejected with a hint, however the first bytes arrive', async () => {
    for (const size of [1, 4]) {
      const e = await failure(read(new Uint8Array([0x1f, 0x8b, 8, 0]), 'a.json.gz', undefined, size));
      expect(e.code).toBe('unsupported-input');
      expect(String(e)).toMatch(/gunzip first/);
    }
  });
});
