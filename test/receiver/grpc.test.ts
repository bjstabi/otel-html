import { create, fromBinary, type Message, toBinary } from '@bufbuild/protobuf';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import {
  type ChannelCredentials,
  credentials,
  makeGenericClientConstructor,
  type ServerInterceptingCallInterface,
  type ServerMethodDefinition,
  type ServiceError,
  status,
} from '@grpc/grpc-js';
import { afterEach, describe, expect, test } from 'vitest';
import { closeAll } from '../../src/api/receiver.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { RetryInfoSchema } from '../../src/model/gen/google/rpc/error_details_pb.js';
import { StatusSchema } from '../../src/model/gen/google/rpc/status_pb.js';
import {
  ExportTraceServiceRequestSchema,
  ExportTraceServiceResponseSchema,
} from '../../src/model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import {
  admissionInterceptor,
  type GrpcTransportOptions,
  listenGrpc,
  serviceDefinition,
} from '../../src/receiver/grpc.js';
import type { Listener } from '../../src/receiver/http.js';
import { type Admission, createReceiver, type Receiver } from '../../src/receiver/receiver.js';
import { serviceOf } from '../../src/receiver/signals.js';
import { openSession, type WriterSession } from '../../src/writer/session.js';
import { decodeResponse, unusedReceive } from '../../test-support/decode.js';
import { createTestWriter, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { allSpans } from '../writer/helpers.js';

const OUT = 'r';
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const open: Listener[] = [];
const clients: { close(): void }[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(open.splice(0).map((l) => l.close()));
});

const traces = serviceOf('traces');
const TracesClient = makeGenericClientConstructor(serviceDefinition(traces), 'TraceService');

interface TracesClientApi {
  Export(request: Uint8Array, callback: (err: ServiceError | null, response?: Message) => void): void;
}

function clientFor(address: string, options: Record<string, string | number> = {}): TracesClientApi {
  const creds: ChannelCredentials = credentials.createInsecure();
  const client = new TracesClient(address, creds, options);
  clients.push(client);
  // The generic constructor names the method after the definition key.
  const exportFn: unknown = Reflect.get(client, 'Export');
  if (typeof exportFn !== 'function') throw new Error('client has no Export');
  return {
    Export: (request, callback) => Reflect.apply(exportFn, client, [request, callback]),
  };
}

async function serve(
  receiver: Receiver,
  options: GrpcTransportOptions = { maxBodyBytes: 1_000_000, inflightBudgetBytes: 1 << 20 },
) {
  const listener = await listenGrpc(receiver, options, silent, '127.0.0.1', 0);
  open.push(listener);
  return listener.address;
}

async function realServer(options?: GrpcTransportOptions) {
  const w: TestWriter = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
  const receiver = createReceiver(session, { inflightBudgetBytes: 1 << 20 }, { logger: silent });
  return { w, session, address: await serve(receiver, options) };
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

function call(
  client: TracesClientApi,
  body: Uint8Array,
): Promise<{ err: ServiceError | null; res: Message | undefined }> {
  return new Promise((resolve) => client.Export(body, (err, res) => resolve({ err, res })));
}

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

const requestOf = (resourceSpans: ReturnType<typeof protoSpan>[]): Uint8Array =>
  toBinary(ExportTraceServiceRequestSchema, create(ExportTraceServiceRequestSchema, { resourceSpans }));

describe('OTLP/gRPC transport', () => {
  test('a port already in use is an OtelHtmlError that keeps EADDRINUSE and hints at the flag', async () => {
    const first = await listenGrpc(
      fake(unusedReceive),
      { maxBodyBytes: 1, inflightBudgetBytes: 1 },
      silent,
      '127.0.0.1',
      0,
    );
    open.push(first);
    const port = Number(first.address.split(':').pop());
    const error = await listenGrpc(
      fake(unusedReceive),
      { maxBodyBytes: 1, inflightBudgetBytes: 1 },
      silent,
      '127.0.0.1',
      port,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OtelHtmlError);
    expect(String((error as Error).message)).toContain('EADDRINUSE');
    expect((error as OtelHtmlError).hint).toContain('--grpc <port>');
  });

  test('export of 2 spans is OK with an empty response; the report holds them', async () => {
    const { w, session, address } = await realServer();
    const body = toBinary(
      ExportTraceServiceRequestSchema,
      create(ExportTraceServiceRequestSchema, {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [1, 2].map((n) => ({
                  traceId: new Uint8Array(16).fill(n),
                  spanId: new Uint8Array(8).fill(n),
                  name: `s${n}`,
                  startTimeUnixNano: 1_700_000_000_000_000_000n,
                  endTimeUnixNano: 1_700_000_000_000_001_000n,
                })),
              },
            ],
          },
        ],
      }),
    );
    const { err, res } = await call(clientFor(address), body);
    expect(err).toBeNull();
    expect(res).toBeDefined();
    expect(
      toBinary(ExportTraceServiceResponseSchema, decodeResponse(ExportTraceServiceResponseSchema, res)),
    ).toHaveLength(0);
    await session.close();
    expect(allSpans(w, OUT)).toHaveLength(2);
  });

  test('a bad entry in the middle is OK with a partial success', async () => {
    const { address } = await realServer();
    const { err, res } = await call(
      clientFor(address),
      requestOf([protoSpan(1), protoSpan(3, 15), protoSpan(4)]),
    );
    expect(err).toBeNull();
    const decoded = decodeResponse(ExportTraceServiceResponseSchema, res);
    expect(decoded.partialSuccess?.rejectedSpans).toBe(1n);
    expect(decoded.partialSuccess?.errorMessage).toMatch(/resourceSpans\[1\]/);
  });

  test('an all-bad body is INVALID_ARGUMENT naming the entry', async () => {
    const { address } = await realServer();
    const { err } = await call(clientFor(address), requestOf([protoSpan(3, 15)]));
    expect(err?.code).toBe(status.INVALID_ARGUMENT);
    expect(err?.details).toMatch(/resourceSpans\[0\]/);
  });

  test('[empty, bad] is INVALID_ARGUMENT naming the entry', async () => {
    const { address } = await realServer();
    const { err } = await call(clientFor(address), requestOf([{ scopeSpans: [] }, protoSpan(3, 15)]));
    expect(err?.code).toBe(status.INVALID_ARGUMENT);
    expect(err?.details).toMatch(/resourceSpans\[1\]/);
  });

  test('a busy receiver is UNAVAILABLE with a RetryInfo of 1 s in grpc-status-details-bin', async () => {
    const address = await serve(
      fake(async () => {
        throw new OtelHtmlError('receiver-busy', { message: 'receiver is busy' });
      }),
    );
    const { err } = await call(clientFor(address), requestOf([]));
    expect(err?.code).toBe(status.UNAVAILABLE);
    const raw = err?.metadata.get('grpc-status-details-bin')[0];
    expect(raw).toBeInstanceOf(Buffer);
    const decoded = fromBinary(StatusSchema, new Uint8Array(raw as Buffer));
    expect(decoded.code).toBe(14);
    expect(decoded.message).toBe('receiver is busy');
    const info = decoded.details[0] && anyUnpack(decoded.details[0], RetryInfoSchema);
    expect(info?.retryDelay?.seconds).toBe(1n);
  });

  test('an unexpected error is INTERNAL with a fixed message', async () => {
    const address = await serve(
      fake(async () => {
        throw new Error('secret path /x');
      }),
    );
    const { err } = await call(clientFor(address), requestOf([]));
    expect(err?.code).toBe(status.INTERNAL);
    expect(err?.details).toBe('internal error');
  });

  test('a message over maxBodyBytes is RESOURCE_EXHAUSTED and counted as too-large', async () => {
    const w: TestWriter = createTestWriter();
    const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
    const receiver = createReceiver(session, { inflightBudgetBytes: 1 << 20 }, { logger: silent });
    const address = await serve(receiver, { maxBodyBytes: 1_000, inflightBudgetBytes: 1 << 20 });
    const { err } = await call(clientFor(address), new Uint8Array(1_500));
    expect(err?.code).toBe(status.RESOURCE_EXHAUSTED);
    expect(err?.details).toBe('request of 1500 bytes exceeds the limit of 1000 bytes');
    expect(receiver.stats().requests).toBe(1);
    expect(receiver.stats().refused['too-large']).toBe(1);
    await session.close();
  });

  test('a message over twice the limit is refused by grpc-js and is not counted', async () => {
    const w: TestWriter = createTestWriter();
    const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
    const receiver = createReceiver(session, { inflightBudgetBytes: 1 << 20 }, { logger: silent });
    const address = await serve(receiver, { maxBodyBytes: 1_000, inflightBudgetBytes: 1 << 20 });
    const { err } = await call(clientFor(address), new Uint8Array(2_500));
    expect(err?.code).toBe(status.RESOURCE_EXHAUSTED);
    expect(receiver.stats().requests).toBe(0);
    await session.close();
  });

  test('an admission refused as busy is UNAVAILABLE with RetryInfo and counted', async () => {
    const refusals: [string, string][] = [];
    const base = fake(unusedReceive, () => null);
    const receiver: Receiver = {
      ...base,
      refused: (outcome, reason) => void refusals.push([outcome, reason]),
    };
    const address = await serve(receiver);
    const { err } = await call(clientFor(address), requestOf([protoSpan(1)]));
    expect(err?.code).toBe(status.UNAVAILABLE);
    const details = err?.metadata.get('grpc-status-details-bin')[0];
    if (!(details instanceof Buffer)) throw new Error('no status details');
    const detail = fromBinary(StatusSchema, details).details[0];
    if (detail === undefined) throw new Error('no RetryInfo');
    expect(anyUnpack(detail, RetryInfoSchema)?.retryDelay?.seconds).toBe(1n);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.[0]).toBe('busy');
  });

  test('a gzip-compressed request is OK', async () => {
    const { w, session, address } = await realServer();
    const { err } = await call(
      clientFor(address, { 'grpc.default_compression_algorithm': 2 }),
      requestOf([protoSpan(1)]),
    );
    expect(err).toBeNull();
    await session.close();
    expect(allSpans(w, OUT)).toHaveLength(1);
  });

  test('listenGrpc on port 0 returns a real port and close() resolves', async () => {
    const listener = await listenGrpc(
      fake(async () => ({ accepted: 0, rejected: 0, errorMessage: null })),
      { maxBodyBytes: 1_000, inflightBudgetBytes: 1_000 },
      silent,
      '127.0.0.1',
      0,
    );
    const match = /^127\.0\.0\.1:(\d+)$/.exec(listener.address);
    expect(Number(match?.[1])).toBeGreaterThan(0);
    await listener.close();
  });

  test('a call queued at shutdown completes once the receiver has drained', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const addEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const calls: string[] = [];
    const session: WriterSession = {
      async add(_input, source) {
        calls.push(`add ${source}`);
        entered();
        await gate;
        return { accepted: 1, dropped: 0, duplicates: 0 };
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
    const receiver = createReceiver(session, { inflightBudgetBytes: 1 << 20 }, { logger: silent });
    const listener = await listenGrpc(
      receiver,
      { maxBodyBytes: 1_000_000, inflightBudgetBytes: 1 << 20, forceShutdownAfterMs: 50 },
      silent,
      '127.0.0.1',
      0,
    );
    open.push(listener);
    const exported = call(clientFor(listener.address), requestOf([protoSpan(1)]));
    await addEntered;
    const closing = closeAll([listener], receiver);
    // The hazard window: well past the force-shutdown deadline while the call is still queued.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    const { err } = await exported;
    await closing;
    expect(err).toBeNull();
    expect(calls).toHaveLength(1);
  });

  describe('admission on call start', () => {
    const own = { 'grpc.use_local_subchannel_pool': 1 };

    function deferred() {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    async function heldReceiver(budget: number) {
      const w: TestWriter = createTestWriter();
      const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
      const real = createReceiver(session, { inflightBudgetBytes: budget }, { logger: silent });
      const gate = deferred();
      let reached = 0;
      const receiver: Receiver = {
        ...real,
        receive: async (_signal, _body, _encoding, _transport, admission) => {
          reached++;
          await gate.promise;
          admission.release();
          return { accepted: 1, rejected: 0, errorMessage: null };
        },
      };
      return { real, receiver, gate, reached: () => reached };
    }

    const tick = () => new Promise((resolve) => setTimeout(resolve, 100));

    test('a call on a second connection is refused busy while a call on the first holds the budget', async () => {
      const { real, receiver, gate, reached } = await heldReceiver(1_000_000);
      const address = await serve(receiver, { maxBodyBytes: 1_000_000, inflightBudgetBytes: 1_000_000 });
      const a = clientFor(address, own);
      const b = clientFor(address, own);
      const first = call(a, requestOf([protoSpan(1)]));
      await tick();
      expect(reached()).toBe(1);
      const second = await call(b, requestOf([protoSpan(2)]));
      expect(second.err?.code).toBe(status.UNAVAILABLE);
      const details = second.err?.metadata.get('grpc-status-details-bin')[0];
      if (!(details instanceof Buffer)) throw new Error('no status details');
      const detail = fromBinary(StatusSchema, new Uint8Array(details)).details[0];
      if (detail === undefined) throw new Error('no RetryInfo');
      expect(anyUnpack(detail, RetryInfoSchema)?.retryDelay?.seconds).toBe(1n);
      expect(real.stats().refused.busy).toBe(1);
      expect(reached()).toBe(1);
      gate.resolve();
      expect((await first).err).toBeNull();
      expect((await call(b, requestOf([protoSpan(3)]))).err).toBeNull();
      expect(real.stats().refused.busy).toBe(1);
    });

    test('two calls on one connection still proceed together under the default-sized budget', async () => {
      const { receiver, gate, reached } = await heldReceiver(2_000);
      const address = await serve(receiver, { maxBodyBytes: 1_000, inflightBudgetBytes: 2_000 });
      const client = clientFor(address, own);
      const one = call(client, requestOf([protoSpan(1)]));
      const two = call(client, requestOf([protoSpan(2)]));
      await tick();
      expect(reached()).toBe(2);
      gate.resolve();
      expect((await one).err).toBeNull();
      expect((await two).err).toBeNull();
    });

    test('a message grpc-js itself refuses as too large does not leak the reservation', async () => {
      const { real, receiver } = await heldReceiver(1_000_000);
      const address = await serve(receiver, { maxBodyBytes: 1_000, inflightBudgetBytes: 1_000_000 });
      const { err } = await call(clientFor(address, own), new Uint8Array(2_500));
      expect(err?.code).toBe(status.RESOURCE_EXHAUSTED);
      await tick();
      // A full-budget admission is only granted while nothing else is open: a leaked reservation would refuse it.
      const probe = real.admit(1_000_000);
      expect(probe).not.toBeNull();
      probe?.release();
    });

    function startedCall(real: Receiver) {
      const interceptor = admissionInterceptor(
        real,
        { maxBodyBytes: 1_000_000, inflightBudgetBytes: 1_000_000 },
        silent,
      );
      let captured: Parameters<ServerInterceptingCallInterface['start']>[0] | undefined;
      const stub: ServerInterceptingCallInterface = {
        start: (listener) => {
          captured = listener;
        },
        sendMetadata() {},
        sendMessage() {},
        sendStatus() {},
        startRead() {},
        getPeer: () => 'peer',
        getDeadline: () => Number.POSITIVE_INFINITY,
        getHost: () => 'host',
        getAuthContext: () => ({}),
        getConnectionInfo: () => ({}),
        getMetricsRecorder: () => {
          throw new Error('unused');
        },
      };
      const method: ServerMethodDefinition<Uint8Array, Message> = {
        path: '/p/Export',
        requestStream: false,
        responseStream: false,
        requestDeserialize: (bytes) => bytes,
        responseSerialize: () => Buffer.alloc(0),
      };
      const intercepted = interceptor(method, stub);
      intercepted.start({
        onReceiveMetadata() {},
        onReceiveMessage() {},
        onReceiveHalfClose() {},
        onCancel() {},
      });
      return () => {
        if (captured === undefined) throw new Error('call was not started');
        return captured;
      };
    }

    test('a call holds the reservation after its message arrives until it half-closes', async () => {
      const { real } = await heldReceiver(1_000_000);
      const listener = startedCall(real);
      listener().onReceiveMessage(new Uint8Array(10));
      expect(real.admit(1_000_000)).toBeNull();
      listener().onReceiveHalfClose();
      const after = real.admit(1_000_000);
      expect(after).not.toBeNull();
      after?.release();
    });

    test('a call cancelled before its message releases the reservation', async () => {
      const { real } = await heldReceiver(1_000_000);
      const listener = startedCall(real);
      // Started and not yet cancelled: the reservation is held, a second one does not fit.
      expect(real.admit(1_000_000)).toBeNull();
      listener().onCancel();
      const after = real.admit(1_000_000);
      expect(after).not.toBeNull();
      after?.release();
    });
  });
});
