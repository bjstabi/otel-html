import { type ClientRequest, type IncomingMessage, request } from 'node:http';
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
import { type Admission, createReceiver, type Receiver } from '../../src/receiver/receiver.js';
import { openSession, type WriterSession } from '../../src/writer/session.js';
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
  return { w, session, receiver, base: await serve(receiver, options) };
}

const stubAdmission: Admission = { bytes: 0, grow: () => true, release() {} };

function fake(receive: Receiver['receive'], admit: Receiver['admit'] = () => stubAdmission): Receiver {
  return {
    admit,
    receive,
    stats: () => ({
      requests: 0,
      bytes: 0,
      accepted: { traces: 0, logs: 0, metrics: 0 },
      rejected: { traces: 0, logs: 0, metrics: 0 },
      refused: {
        invalid: 0,
        'too-large': 0,
        unsupported: 0,
        'not-found': 0,
        method: 0,
        busy: 0,
        internal: 0,
      },
    }),
    refused: () => undefined,
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

/** A real receiver with a 1000-byte budget over a session whose `add` waits for `release()`, so a request stays in flight. */
async function gatedServer() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session: WriterSession = {
    async add() {
      await gate;
      return { accepted: 1 } as never;
    },
    async endInput() {},
    async addRecords() {
      throw new Error('unused');
    },
    async flush() {},
    async close() {
      throw new Error('unused');
    },
    async abort() {},
  };
  const receiver = createReceiver(session, { inflightBudgetBytes: 1000 }, { logger: silent });
  const base = await serve(receiver);
  return { receiver, base, release };
}

const sent: ClientRequest[] = [];
afterEach(() => {
  for (const r of sent.splice(0)) r.destroy();
});

/** Opens a request whose headers are sent at once; the caller writes the body. `response` settles on the first response. */
function openRequest(base: string, headers: Record<string, string>) {
  const req = request(`${base}/v1/traces`, { method: 'POST', headers: { ...JSON_HEADERS, ...headers } });
  sent.push(req);
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.once('response', resolve);
    req.once('error', reject);
  });
  req.flushHeaders();
  return { req, response };
}

/** Starts a first, complete 600-byte upload and returns once the receiver has admitted it. */
async function startFirst(base: string, receiver: Receiver): Promise<{ response: Promise<Response> }> {
  const body = JSON.stringify({ ...spansRequest(1), pad: 'x'.repeat(500) });
  const first = post(base, '/v1/traces', body, JSON_HEADERS);
  while (receiver.stats().bytes === 0) await new Promise((r) => setImmediate(r));
  return { response: first };
}

describe('OTLP/HTTP transport', () => {
  test('a port already in use is an OtelHtmlError that keeps EADDRINUSE and hints at the flag', async () => {
    const first = await listenHttp(
      createHttpHandler(
        fake(async () => undefined as never),
        { maxBodyBytes: 1 },
        silent,
      ),
      '127.0.0.1',
      0,
    );
    open.push(first);
    const port = Number(first.address.split(':').pop());
    const error = await listenHttp(
      createHttpHandler(
        fake(async () => undefined as never),
        { maxBodyBytes: 1 },
        silent,
      ),
      '127.0.0.1',
      port,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OtelHtmlError);
    expect(String((error as Error).message)).toContain('EADDRINUSE');
    expect((error as OtelHtmlError).hint).toContain('--http <port>');
  });

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

  test('[empty, bad] is 400 with a status naming the entry', async () => {
    const { base } = await realServer();
    const body = toBinary(
      ExportTraceServiceRequestSchema,
      create(ExportTraceServiceRequestSchema, { resourceSpans: [{ scopeSpans: [] }, protoSpan(3, 15)] }),
    );
    const res = await post(base, '/v1/traces', bytes(body), PROTO_HEADERS);
    expect(res.status).toBe(400);
    const status = fromBinary(StatusSchema, new Uint8Array(await res.arrayBuffer()));
    expect(status.code).toBe(3);
    expect(status.message).toMatch(/resourceSpans\[1\]/);
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

  test('Content-Encoding identity with a plain JSON body: 200 {}', async () => {
    const { base } = await realServer();
    const res = await post(base, '/v1/traces', '{}', { ...JSON_HEADERS, 'content-encoding': 'identity' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
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

  test('a streamed gzip body without Content-Length that inflates past the limit is 413, not a reset', async () => {
    const { receiver, base } = await realServer({ maxBodyBytes: 100_000 });
    const body = gzipSync(Buffer.alloc(80_000_000));
    const url = new URL(`${base}/v1/traces`);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        url,
        { method: 'POST', headers: { ...JSON_HEADERS, 'content-encoding': 'gzip' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      const head = Math.floor(body.length / 2);
      req.write(body.subarray(0, head)); // chunked: no Content-Length
      // The rest arrives after the server has seen the limit exceeded.
      setTimeout(() => req.end(body.subarray(head)), 100);
    });
    expect(status).toBe(413);
    expect(receiver.stats().refused['too-large']).toBe(1);
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

  test('refused requests show up in stats by outcome: undecodable, unsupported, not found, method and busy', async () => {
    const { receiver, base } = await realServer();
    expect((await post(base, '/v1/traces', '{nope', JSON_HEADERS)).status).toBe(400);
    expect((await post(base, '/v1/traces', '{nope', JSON_HEADERS)).status).toBe(400);
    expect((await post(base, '/v1/traces', 'hi', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(base, '/v1/other', '{}', JSON_HEADERS)).status).toBe(404);
    expect((await fetch(`${base}/v1/traces`)).status).toBe(405);
    await receiver.close();
    expect((await post(base, '/v1/traces', '{}', JSON_HEADERS)).status).toBe(503);
    const s = receiver.stats();
    expect(s.requests).toBe(6);
    expect(s.refused).toEqual({
      invalid: 2,
      unsupported: 1,
      'not-found': 1,
      method: 1,
      busy: 1,
      'too-large': 0,
      internal: 0,
    });
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

  test('a second upload is answered 503 from its Content-Length before its body is sent', async () => {
    const { receiver, base, release } = await gatedServer();
    const first = (await startFirst(base, receiver)).response;
    const second = openRequest(base, { 'content-length': '600' }); // no body is ever written
    const res = await second.response;
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    res.resume();
    expect(receiver.stats().refused.busy).toBe(1);
    release();
    expect((await first).status).toBe(200);
  });

  test('a chunked body that grows past the budget while another is in flight is 503', async () => {
    const { receiver, base, release } = await gatedServer();
    const first = (await startFirst(base, receiver)).response;
    const second = openRequest(base, { 'transfer-encoding': 'chunked' });
    let ended = false;
    second.req.once('finish', () => {
      ended = true;
    });
    const chunk = Buffer.alloc(100, 'x');
    const writes = (async () => {
      for (let i = 0; i < 10 && !second.req.destroyed; i++) {
        if (!second.req.write(chunk)) await new Promise((r) => second.req.once('drain', r));
        await new Promise((r) => setImmediate(r));
      }
    })();
    const res = await second.response;
    expect(res.statusCode).toBe(503);
    expect(ended).toBe(false);
    res.resume();
    second.req.destroy();
    await writes.catch(() => undefined);
    expect(receiver.stats().refused.busy).toBe(1);
    release();
    expect((await first).status).toBe(200);
  });

  test('a gzip body is counted inflated', async () => {
    const { receiver, base, release } = await gatedServer();
    const first = (await startFirst(base, receiver)).response;
    const gz = gzipSync(Buffer.alloc(2000, 'x'));
    expect(gz.length).toBeLessThan(100);
    const res = await post(base, '/v1/traces', bytes(gz), { ...JSON_HEADERS, 'content-encoding': 'gzip' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(receiver.stats().refused.busy).toBe(1);
    release();
    expect((await first).status).toBe(200);
  });

  test('an invalid body releases its admission', async () => {
    const { receiver, base, release } = await gatedServer();
    release();
    const bad = await post(base, '/v1/traces', '{not json', JSON_HEADERS);
    expect(bad.status).toBe(400);
    expect(receiver.admit(1_000_000)).not.toBeNull();
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
