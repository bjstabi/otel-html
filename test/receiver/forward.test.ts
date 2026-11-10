import { afterEach, describe, expect, test, vi } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { createForwarder, parseOtlpHeaders, SIGNAL_PATH } from '../../src/receiver/forward.js';
import type { Logger } from '../../src/writer/ports.js';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

function recorder(status = 200): { calls: Call[]; fetchFn: typeof fetch } {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body instanceof Uint8Array ? init.body : new Uint8Array(),
    });
    return new Response(null, { status });
  };
  return { calls, fetchFn };
}

function loggerOf(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  const none = (): void => undefined;
  return { logger: { debug: none, info: none, error: none, warn: (m) => warns.push(m) }, warns };
}

const never: typeof fetch = () => new Promise<Response>(() => undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe('parseOtlpHeaders', () => {
  test('parses key=value pairs and URL-decodes the values', () => {
    expect(parseOtlpHeaders('a=1, b=x%20y%3D,c=')).toEqual({ a: '1', b: 'x y=', c: '' });
  });
  test('nothing is no headers', () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders('')).toEqual({});
  });
  test.each(['novalue', '=v', 'a=%zz', 'a=1,,b=2'])('%s is a usage error', (text) => {
    expect(() => parseOtlpHeaders(text)).toThrow(OtelHtmlError);
  });
});

describe('secrets', () => {
  const SECRET = 's3cr3t-value';

  test.each(['Bearer', `a=1,${SECRET}`, `bad name=${SECRET}`, 'a=%zz'])(
    'a malformed header text (%s) is a usage error that never prints the values',
    (text) => {
      const withSecret = text === 'a=%zz' ? `a=%zz${SECRET}` : text;
      try {
        parseOtlpHeaders(withSecret);
      } catch (e) {
        if (!(e instanceof OtelHtmlError)) throw e;
        expect(e.code).toBe('usage');
        expect(`${e.message} ${e.hint ?? ''}`).not.toContain(SECRET);
        return;
      }
      throw new Error('expected a usage error');
    },
  );

  test('a failing fetch whose error text holds a header value logs no value', async () => {
    const { logger, warns } = loggerOf();
    const logged: unknown[] = [];
    const spy: Logger = { ...logger, warn: (m, a) => logged.push(m, a) };
    const fetchFn: typeof fetch = () => Promise.reject(new TypeError(`bad header value ${SECRET}`));
    const f = createForwarder({
      endpoint: 'http://c',
      headers: { authorization: SECRET },
      fetchFn,
      logger: spy,
    });
    f.enqueue('traces', new Uint8Array(1), 'protobuf');
    await f.close();
    expect(warns).toHaveLength(0);
    expect(logged).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });
});

describe('createForwarder', () => {
  test('close does not hang on a response body that cannot be cancelled', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream({ cancel: () => new Promise(() => undefined) });
    const fetchFn: typeof fetch = async () => new Response(body, { status: 200 });
    const f = createForwarder({ endpoint: 'http://c', headers: {}, fetchFn, logger: loggerOf().logger });
    f.enqueue('traces', new Uint8Array(1), 'protobuf');
    const closing = f.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
    expect(f.stats().forwarded + f.stats().failed).toBe(1);
  });

  test('posts a protobuf body to the signal path with the configured headers', async () => {
    const { calls, fetchFn } = recorder();
    const { logger } = loggerOf();
    const f = createForwarder({
      endpoint: 'http://c:4318/',
      headers: { authorization: 'Bearer x' },
      fetchFn,
      logger,
    });
    const body = new Uint8Array([1, 2, 3]);
    f.enqueue('traces', body, 'protobuf');
    await f.close();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://c:4318${SIGNAL_PATH.traces}`);
    expect(calls[0]?.headers['content-type']).toBe('application/x-protobuf');
    expect(calls[0]?.headers).toMatchObject({ authorization: 'Bearer x' });
    expect(calls[0]?.body).toEqual(body);
    expect(f.stats()).toEqual({ forwarded: 1, dropped: 0, failed: 0 });
  });

  test('a JSON body keeps application/json; logs and metrics have their paths', async () => {
    const { calls, fetchFn } = recorder();
    const f = createForwarder({ endpoint: 'http://c', headers: {}, fetchFn, logger: loggerOf().logger });
    f.enqueue('logs', new TextEncoder().encode('{}'), 'json');
    f.enqueue('metrics', new Uint8Array(), 'json');
    await f.close();
    expect(calls.map((c) => c.url)).toEqual(['http://c/v1/logs', 'http://c/v1/metrics']);
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  test('a configured content-type header does not override the request one', async () => {
    const { calls, fetchFn } = recorder();
    const f = createForwarder({
      endpoint: 'http://c',
      headers: { 'Content-Type': 'text/plain' },
      fetchFn,
      logger: loggerOf().logger,
    });
    f.enqueue('traces', new Uint8Array(1), 'protobuf');
    await f.close();
    expect(calls[0]?.headers['content-type']).toBe('application/x-protobuf');
  });

  test('the 65th queued request is dropped and counted', async () => {
    vi.useFakeTimers();
    const f = createForwarder({
      endpoint: 'http://c',
      headers: {},
      fetchFn: never,
      logger: loggerOf().logger,
    });
    for (let i = 0; i < 65; i++) f.enqueue('traces', new Uint8Array(1), 'protobuf');
    expect(f.stats().dropped).toBe(1);
    const closing = f.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
  });

  test('bytes over the byte bound drop too', async () => {
    vi.useFakeTimers();
    const f = createForwarder({
      endpoint: 'http://c',
      headers: {},
      maxQueuedBytes: 10,
      fetchFn: never,
      logger: loggerOf().logger,
    });
    f.enqueue('traces', new Uint8Array(6), 'protobuf');
    f.enqueue('traces', new Uint8Array(5), 'protobuf');
    expect(f.stats().dropped).toBe(1);
    f.enqueue('traces', new Uint8Array(4), 'protobuf');
    expect(f.stats().dropped).toBe(1);
    const closing = f.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
  });

  test('failures are counted and warned about once', async () => {
    const { logger, warns } = loggerOf();
    const f = createForwarder({ endpoint: 'http://c', headers: {}, fetchFn: recorder(500).fetchFn, logger });
    f.enqueue('traces', new Uint8Array(1), 'protobuf');
    f.enqueue('traces', new Uint8Array(1), 'protobuf');
    await f.close();
    expect(f.stats()).toEqual({ forwarded: 0, dropped: 0, failed: 2 });
    expect(warns).toHaveLength(1);
  });

  test('a thrown fetch is a failure', async () => {
    const { logger, warns } = loggerOf();
    const fetchFn: typeof fetch = () => Promise.reject(new Error('refused'));
    const f = createForwarder({ endpoint: 'http://c', headers: {}, fetchFn, logger });
    f.enqueue('traces', new Uint8Array(1), 'protobuf');
    await f.close();
    expect(f.stats().failed).toBe(1);
    expect(warns).toHaveLength(1);
  });

  test('a request that outlives the timeout fails', async () => {
    vi.useFakeTimers();
    const f = createForwarder({
      endpoint: 'http://c',
      headers: {},
      timeoutMs: 100,
      fetchFn: never,
      logger: loggerOf().logger,
    });
    f.enqueue('traces', new Uint8Array(1), 'protobuf');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.stats().failed).toBe(1);
    await f.close();
  });

  test('close gives up on a stuck request after 5 s and counts it failed', async () => {
    vi.useFakeTimers();
    const f = createForwarder({
      endpoint: 'http://c',
      headers: {},
      fetchFn: never,
      logger: loggerOf().logger,
    });
    f.enqueue('traces', new Uint8Array(1), 'protobuf');
    let closed = false;
    const closing = f.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(f.stats().failed).toBe(1);
  });

  test('enqueue after close is dropped', async () => {
    const { calls, fetchFn } = recorder();
    const f = createForwarder({ endpoint: 'http://c', headers: {}, fetchFn, logger: loggerOf().logger });
    await f.close();
    f.enqueue('traces', new Uint8Array(1), 'protobuf');
    expect(calls).toHaveLength(0);
    expect(f.stats().dropped).toBe(1);
  });
});
