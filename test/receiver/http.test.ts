import { request } from 'node:http';
import { gzipSync } from 'node:zlib';
import { create, fromBinary, fromJson, type JsonValue, toBinary } from '@bufbuild/protobuf';
import { afterEach, describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { StatusSchema } from '../../src/model/gen/google/rpc/status_pb.js';
import {
  ExportLogsServiceRequestSchema,
  ExportLogsServiceResponseSchema,
} from '../../src/model/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import {
  ExportTraceServiceRequestSchema,
  ExportTraceServiceResponseSchema,
} from '../../src/model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import {
  CORS_ORIGIN,
  createHttpHandler,
  type HttpTransportOptions,
  type Listener,
  listenHttp,
} from '../../src/receiver/http.js';
import { createReceiver, type Receiver } from '../../src/receiver/receiver.js';
import { openSession } from '../../src/writer/session.js';
import { createTestWriter, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { allSpans, spansRequest } from '../writer/helpers.js';

const OUT = 'r';
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const open: Listener[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((l) => l.close()));
});

async function serve(receiver: Receiver, options: HttpTransportOptions = { maxBodyBytes: 1_000_000 }) {
  const listener = await listenHttp(createHttpHandler(receiver, options, silent), '127.0.0.1', 0);
  open.push(listener);
  return listener.address;
}

async function realServer(options?: HttpTransportOptions) {
  const w: TestWriter = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'create' });
  const receiver = createReceiver(session, { inflightBudgetBytes: 1 << 20 }, { logger: silent });
  return { w, session, base: await serve(receiver, options) };
}

function fake(receive: Receiver['receive']): Receiver {
  return {
    receive,
    stats: () => ({
      requests: 0,
      bytes: 0,
      accepted: { traces: 0, logs: 0, metrics: 0 },
      rejected: { traces: 0, logs: 0, metrics: 0 },
    }),
    close: async () => undefined,
  };
}

const post = (base: string, path: string, body: Uint8Array | string, headers: Record<string, string>) =>
  fetch(base + path, { method: 'POST', body, headers });
const JSON_HEADERS = { 'content-type': 'application/json' };
const PROTO_HEADERS = { 'content-type': 'application/x-protobuf' };
const bytes = (u: Uint8Array): Uint8Array => u;

const protoSpan = (n: number, traceLen = 16) => ({
  scopeSpans: [
    {
      spans: [
        {
          traceId: new Uint8Array(traceLen).fill(n),
          spanId: new Uint8Array(8).fill(n),
          name: 's',
          startTimeUnixNano: 1_700_000_000_000_000_000n,
          endTimeUnixNano: 1_700_000_000_000_001_000n,
        },
      ],
    },
  ],
});

describe('OTLP/HTTP transport', () => {
  test('JSON traces: 200 with an empty JSON response; the spans are in the report', async () => {
    const { w, session, base } = await realServer();
    const res = await post(base, '/v1/traces', JSON.stringify(spansRequest(2)), JSON_HEADERS);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({});
    await session.close();
    expect(allSpans(w, OUT)).toHaveLength(2);
  });

  test('protobuf logs: 200 with an empty protobuf response', async () => {
    const { base } = await realServer();
    const body = toBinary(ExportLogsServiceRequestSchema, create(ExportLogsServiceRequestSchema, {}));
    const res = await post(base, '/v1/logs', bytes(body), PROTO_HEADERS);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-protobuf');
    const decoded = fromBinary(ExportLogsServiceResponseSchema, new Uint8Array(await res.arrayBuffer()));
    expect(decoded.partialSuccess).toBeUndefined();
  });

  test('a bad entry in the middle is a partial success naming the entry', async () => {
    const { base } = await realServer();
    const body = toBinary(
      ExportTraceServiceRequestSchema,
      create(ExportTraceServiceRequestSchema, {
        resourceSpans: [protoSpan(1), protoSpan(3, 15), protoSpan(4)],
      }),
    );
    const res = await post(base, '/v1/traces', bytes(body), PROTO_HEADERS);
    expect(res.status).toBe(200);
    const decoded = fromBinary(ExportTraceServiceResponseSchema, new Uint8Array(await res.arrayBuffer()));
    expect(decoded.partialSuccess?.rejectedSpans).toBe(1n);
    expect(decoded.partialSuccess?.errorMessage).toMatch(/resourceSpans\[1\]/);
  });

  test('gzip {} with a charset parameter: 200 {} and nothing written', async () => {
    const { w, session, base } = await realServer();
    const res = await post(base, '/v1/traces', bytes(gzipSync('{}')), {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    await session.close();
    expect(allSpans(w, OUT)).toHaveLength(0);
  });

  test('gzip protobuf is inflated', async () => {
    const { w, session, base } = await realServer();
    const body = toBinary(
      ExportTraceServiceRequestSchema,
      create(ExportTraceServiceRequestSchema, { resourceSpans: [protoSpan(1)] }),
    );
    const res = await post(base, '/v1/traces', bytes(gzipSync(body)), {
      ...PROTO_HEADERS,
      'content-encoding': 'gzip',
    });
    expect(res.status).toBe(200);
    await session.close();
    expect(allSpans(w, OUT)).toHaveLength(1);
  });

  test('a corrupt gzip body is 400', async () => {
    const { base } = await realServer();
    const res = await post(base, '/v1/traces', 'not gzip at all', {
      ...JSON_HEADERS,
      'content-encoding': 'gzip',
    });
    expect(res.status).toBe(400);
  });

  test('unsupported content type and encoding are 415 with a JSON status', async () => {
    const { base } = await realServer();
    const text = await post(base, '/v1/traces', '{}', { 'content-type': 'text/plain' });
    expect(text.status).toBe(415);
    expect(await text.json()).toEqual({ code: 3, message: expect.stringMatching(/content-type/) });
    const none = await fetch(`${base}/v1/traces`, { method: 'POST' });
    expect(none.status).toBe(415);
    const br = await post(base, '/v1/traces', '{}', { ...JSON_HEADERS, 'content-encoding': 'br' });
    expect(br.status).toBe(415);
    expect(await br.json()).toEqual({ code: 3, message: expect.stringMatching(/content-encoding/) });
  });

  test('405 with Allow, and 404 for other paths', async () => {
    const { base } = await realServer();
    const get = await fetch(`${base}/v1/traces`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, OPTIONS');
    expect((await post(base, '/v1/other', '{}', JSON_HEADERS)).status).toBe(404);
    expect((await post(base, '/v1/traces/', '{}', JSON_HEADERS)).status).toBe(404);
  });

  test('a Content-Length over the limit is 413 before the body is sent', async () => {
    const { base } = await realServer({ maxBodyBytes: 1_000_000 });
    const url = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          path: '/v1/traces',
          method: 'POST',
          headers: { ...JSON_HEADERS, 'content-length': '70000000' },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
  });

  test('a gzip body that inflates past the limit is 413', async () => {
    const { base } = await realServer({ maxBodyBytes: 100_000 });
    const body = gzipSync(Buffer.alloc(2_000_000));
    expect(body.length).toBeLessThan(100_000);
    const res = await post(base, '/v1/traces', bytes(body), {
      ...JSON_HEADERS,
      'content-encoding': 'gzip',
    });
    expect(res.status).toBe(413);
  });

  test('undecodable bodies are 400 with a status', async () => {
    const { base } = await realServer();
    const json = await post(base, '/v1/traces', '{nope', JSON_HEADERS);
    expect(json.status).toBe(400);
    expect(await json.json()).toEqual({ code: 3, message: expect.stringMatching(/invalid JSON/) });
    const proto = await post(base, '/v1/traces', bytes(new Uint8Array(20).fill(0xff)), PROTO_HEADERS);
    expect(proto.status).toBe(400);
    const status = fromBinary(StatusSchema, new Uint8Array(await proto.arrayBuffer()));
    expect(status.code).toBe(3);
    expect(status.message).not.toBe('');
  });

  test('busy is 503 with Retry-After', async () => {
    const base = await serve(
      fake(async () => {
        throw new OtelHtmlError('receiver-busy', { message: 'receiver is busy' });
      }),
    );
    const res = await post(base, '/v1/traces', '{}', JSON_HEADERS);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await res.json()).toEqual({ code: 14, message: 'receiver is busy' });
  });

  test('a retried span batch is accepted both times, without a partial success', async () => {
    const { w, session, base } = await realServer();
    const body = JSON.stringify(spansRequest(2));
    expect((await post(base, '/v1/traces', body, JSON_HEADERS)).status).toBe(200);
    const second = await post(base, '/v1/traces', body, JSON_HEADERS);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({});
    await session.close();
    expect(allSpans(w, OUT)).toHaveLength(2);
  });

  test('an unexpected failure is 500 with a fixed message', async () => {
    const base = await serve(
      fake(async () => {
        throw new Error('disk full');
      }),
    );
    const res = await post(base, '/v1/traces', '{}', JSON_HEADERS);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 13, message: 'internal error' });
  });

  test('the status body round-trips as a google.rpc.Status', async () => {
    const base = await serve(fake(async () => undefined as never));
    const res = await post(base, '/v1/other', '{}', JSON_HEADERS);
    const status = fromJson(StatusSchema, (await res.json()) as JsonValue);
    expect(status.code).toBe(3);
  });

  describe('CORS', () => {
    test('a localhost origin is reflected', async () => {
      const { base } = await realServer();
      const res = await post(base, '/v1/traces', '{}', { ...JSON_HEADERS, origin: 'http://localhost:5173' });
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(res.headers.get('vary')).toBe('Origin');
    });

    test('a preflight is answered 204', async () => {
      const { base } = await realServer();
      const res = await fetch(`${base}/v1/traces`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://127.0.0.1:3000',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type, x-custom',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3000');
      expect(res.headers.get('access-control-allow-methods')).toBe('POST');
      expect(res.headers.get('access-control-allow-headers')).toBe('content-type, x-custom');
      expect(res.headers.get('access-control-max-age')).toBe('600');
    });

    test('a preflight without requested headers gets the defaults', async () => {
      const { base } = await realServer();
      const res = await fetch(`${base}/v1/logs`, {
        method: 'OPTIONS',
        headers: { origin: 'http://[::1]:80' },
      });
      expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type, Content-Encoding');
    });

    test('another origin gets no CORS headers', async () => {
      const { base } = await realServer();
      const res = await post(base, '/v1/traces', '{}', { ...JSON_HEADERS, origin: 'https://evil.example' });
      expect(res.status).toBe(200);
      expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
      const pre = await fetch(`${base}/v1/traces`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      });
      expect([...pre.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
    });

    test.each([
      ['http://localhost', true],
      ['https://localhost:8443', true],
      ['http://[::1]:4000', true],
      ['http://localhost.evil.example', false],
      ['http://localhost:abc', false],
      ['null', false],
    ])('CORS_ORIGIN %s -> %s', (origin, ok) => {
      expect(CORS_ORIGIN.test(origin)).toBe(ok);
    });
  });

  test('listenHttp binds the port it reports and close frees it', async () => {
    const listener = await listenHttp(
      createHttpHandler(
        fake(async () => undefined as never),
        { maxBodyBytes: 10 },
        silent,
      ),
      '127.0.0.1',
      0,
    );
    const port = Number(new URL(listener.address).port);
    expect(port).toBeGreaterThan(0);
    expect(listener.address).toBe(`http://127.0.0.1:${port}`);
    await listener.close();
    await expect(fetch(`${listener.address}/v1/traces`, { method: 'POST' })).rejects.toThrow();
  });
});
