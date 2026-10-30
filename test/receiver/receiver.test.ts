import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { ExportTraceServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import { createReceiver, type Receiver } from '../../src/receiver/receiver.js';
import { openSession, type WriterSession } from '../../src/writer/session.js';
import { logRecord, logsRequest, span, traceRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { allSpans, spansRequest } from '../writer/helpers.js';

const OUT = 'r';
function resourceSpansOf(req: { readonly [k: string]: unknown }): unknown[] {
  const v = Reflect.get(req, 'resourceSpans');
  if (!Array.isArray(v)) throw new Error('fixture');
  return v;
}
const encode = (v: unknown): Uint8Array =>
  new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

async function realReceiver(
  w: TestWriter,
  inflightBudgetBytes = 1 << 20,
): Promise<{ receiver: Receiver; session: WriterSession }> {
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'create' });
  return { receiver: createReceiver(session, { inflightBudgetBytes }, { logger: w.deps.logger }), session };
}

function twoEntryTraces(): unknown {
  return {
    resourceSpans: [...resourceSpansOf(spansRequest(2, 0, 0)), ...resourceSpansOf(spansRequest(2, 0, 2))],
  };
}

const ENTRY = (traceId: Uint8Array, spanId: number) => ({
  scopeSpans: [
    {
      spans: [
        {
          traceId,
          spanId: new Uint8Array(8).fill(spanId),
          name: 's',
          startTimeUnixNano: 1_700_000_000_000_000_000n,
          endTimeUnixNano: 1_700_000_000_000_001_000n,
        },
      ],
    },
  ],
});

interface FakeControl {
  session: WriterSession;
  calls: string[];
  release: () => void;
}

/** A session whose `add` waits for `release()` when `block` is set, recording the call order. */
function fakeSession(block: boolean): FakeControl {
  const calls: string[] = [];
  let release: () => void = () => undefined;
  const gate = block
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  const session: WriterSession = {
    async add(_input, source) {
      calls.push(`add ${source}`);
      await gate;
      return { accepted: 1 } as never;
    },
    async endInput() {
      calls.push('endInput');
    },
    async addRecords() {
      throw new Error('unused');
    },
    async flush() {},
    async close() {
      throw new Error('unused');
    },
    async abort() {},
  };
  return { session, calls, release };
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('createReceiver', () => {
  test('JSON traces with two entries of two spans', async () => {
    const w = createTestWriter();
    const { receiver, session } = await realReceiver(w);
    const r = await receiver.receive('traces', encode(twoEntryTraces()), 'json', 'otlp/http');
    expect(r).toEqual({ accepted: 4, rejected: 0, errorMessage: null });
    await session.close();
    expect(allSpans(w, OUT)).toHaveLength(4);
  });

  test('protobuf with a bad entry in the middle is partially accepted', async () => {
    const w = createTestWriter();
    const { receiver, session } = await realReceiver(w);
    const good = (n: number) => ENTRY(new Uint8Array(16).fill(n), n);
    const twoSpans = {
      scopeSpans: [
        { spans: [...(good(1).scopeSpans[0]?.spans ?? []), ...(good(2).scopeSpans[0]?.spans ?? [])] },
      ],
    };
    const body = toBinary(
      ExportTraceServiceRequestSchema,
      create(ExportTraceServiceRequestSchema, {
        resourceSpans: [twoSpans, ENTRY(new Uint8Array(15).fill(3), 3), good(4)],
      }),
    );
    const r = await receiver.receive('traces', body, 'protobuf', 'otlp/grpc');
    expect(r.accepted).toBe(3);
    expect(r.rejected).toBe(1);
    expect(r.errorMessage).toMatch(/resourceSpans\[1\]/);
    await session.close();
    expect(allSpans(w, OUT)).toHaveLength(3);
  });

  test('a body whose only entry is bad is invalid-otlp, and counted rejected', async () => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    const body = toBinary(
      ExportTraceServiceRequestSchema,
      create(ExportTraceServiceRequestSchema, { resourceSpans: [ENTRY(new Uint8Array(15).fill(3), 3)] }),
    );
    expect((await failure(receiver.receive('traces', body, 'protobuf', 'otlp/grpc'))).code).toBe(
      'invalid-otlp',
    );
    expect(receiver.stats().rejected.traces).toBe(1);
  });

  test('a protobuf body that fails to decode partway writes nothing', async () => {
    const w = createTestWriter();
    const { receiver, session } = await realReceiver(w);
    const good = toBinary(
      ExportTraceServiceRequestSchema,
      create(ExportTraceServiceRequestSchema, { resourceSpans: [ENTRY(new Uint8Array(16).fill(1), 1)] }),
    );
    const body = new Uint8Array([...good, 0x0a, 0x7f, 0x01]);
    expect((await failure(receiver.receive('traces', body, 'protobuf', 'otlp/grpc'))).code).toBe(
      'invalid-otlp',
    );
    await session.close();
    expect(allSpans(w, OUT)).toHaveLength(0);
    expect(receiver.stats().accepted.traces).toBe(0);
  });

  test('empty and signal-less bodies', async () => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    const empty = { accepted: 0, rejected: 0, errorMessage: null };
    expect(await receiver.receive('logs', encode('{}'), 'json', 'otlp/http')).toEqual(empty);
    expect(await receiver.receive('logs', encode({ resourceLogs: [] }), 'json', 'otlp/http')).toEqual(empty);
    expect(await receiver.receive('traces', new Uint8Array(), 'protobuf', 'otlp/grpc')).toEqual(empty);
    const wrong = await failure(
      receiver.receive('traces', encode({ resourceLogs: [] }), 'json', 'otlp/http'),
    );
    expect(wrong.code).toBe('invalid-otlp');
    expect(wrong.message).toMatch(/expected resourceSpans/);
  });

  test.each(['[1,2]', 'not json'])('%s is invalid-otlp', async (text) => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    expect((await failure(receiver.receive('traces', encode(text), 'json', 'otlp/http'))).code).toBe(
      'invalid-otlp',
    );
  });

  test('budget: a second receive over the budget is refused while one is in flight', async () => {
    const fake = fakeSession(true);
    const receiver = createReceiver(fake.session, { inflightBudgetBytes: 100 }, { logger: silent });
    const body = encode({ ...traceRequest([span()]), pad: 'x'.repeat(40) });
    expect(body.length).toBeGreaterThan(50);
    const first = receiver.receive('traces', body, 'json', 'otlp/http');
    const second = await failure(receiver.receive('traces', body, 'json', 'otlp/http'));
    expect(second.code).toBe('receiver-busy');
    fake.release();
    await first;
  });

  test('budget: a lone receive above the budget succeeds', async () => {
    const fake = fakeSession(false);
    const receiver = createReceiver(fake.session, { inflightBudgetBytes: 100 }, { logger: silent });
    const padded = encode({ ...traceRequest([span()]), pad: 'x'.repeat(150) });
    expect(padded.length).toBeGreaterThan(150);
    const r = await receiver.receive('traces', padded, 'json', 'otlp/http');
    expect(r.accepted).toBe(1);
  });

  test('receives are serialized: one request ends its input before the next adds', async () => {
    const fake = fakeSession(true);
    const receiver = createReceiver(fake.session, { inflightBudgetBytes: 1 << 20 }, { logger: silent });
    const body = encode(traceRequest([span()]));
    const a = receiver.receive('traces', body, 'json', 'a');
    const b = receiver.receive('traces', body, 'json', 'b');
    await Promise.resolve();
    fake.release();
    await Promise.all([a, b]);
    expect(fake.calls).toEqual(['add a', 'endInput', 'add b', 'endInput']);
  });

  test('epoch: earlier data is fine, data over 104 days later is rejected', async () => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    const hour = 3_600_000_000_000;
    const day = 86_400_000_000_000;
    const at = (offset: number) => spansRequest(1, offset, 0);
    expect((await receiver.receive('traces', encode(at(0)), 'json', 'otlp/http')).accepted).toBe(1);
    expect((await receiver.receive('traces', encode(at(-hour)), 'json', 'otlp/http')).accepted).toBe(1);
    const late = await failure(receiver.receive('traces', encode(at(200 * day)), 'json', 'otlp/http'));
    expect(late.code).toBe('invalid-otlp');
    expect(receiver.stats().rejected.traces).toBe(1);
    expect(receiver.stats().accepted.traces).toBe(2);
  });

  test('a late entry reports time-out-of-range as a partial rejection', async () => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    const day = 86_400_000_000_000;
    const resourceSpans = [
      ...resourceSpansOf(spansRequest(1, 0, 0)),
      ...resourceSpansOf(spansRequest(1, 200 * day, 1)),
    ];
    const r = await receiver.receive('traces', encode({ resourceSpans }), 'json', 'otlp/http');
    expect(r.accepted).toBe(1);
    expect(r.rejected).toBe(1);
    expect(r.errorMessage).not.toBeNull();
  });

  test('close waits for the receive in progress; later receives are busy', async () => {
    const fake = fakeSession(true);
    const receiver = createReceiver(fake.session, { inflightBudgetBytes: 1 << 20 }, { logger: silent });
    const body = encode(traceRequest([span()]));
    let done = false;
    const inflight = receiver.receive('traces', body, 'json', 'a').then((r) => {
      done = true;
      return r;
    });
    await Promise.resolve();
    const closing = receiver.close().then(() => {
      expect(done).toBe(true);
    });
    expect((await failure(receiver.receive('traces', body, 'json', 'b'))).code).toBe('receiver-busy');
    fake.release();
    await inflight;
    await closing;
    await receiver.close();
  });

  test('stats count requests, bytes, accepted and rejected', async () => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    const logs = encode(logsRequest([logRecord()]));
    const traces = encode(twoEntryTraces());
    await receiver.receive('traces', traces, 'json', 'otlp/http');
    await receiver.receive('logs', logs, 'json', 'otlp/http');
    const s = receiver.stats();
    expect(s.requests).toBe(2);
    expect(s.bytes).toBe(traces.length + logs.length);
    expect(s.accepted).toEqual({ traces: 4, logs: 1, metrics: 0 });
    expect(s.rejected).toEqual({ traces: 0, logs: 0, metrics: 0 });
  });

  test('a write failure after some entries counts what was added and no rejections', async () => {
    const fake = fakeSession(false);
    let n = 0;
    const failing: WriterSession = {
      ...fake.session,
      async add() {
        if (++n === 2) throw new Error('disk full');
        return { accepted: 1 } as never;
      },
    };
    const receiver = createReceiver(failing, { inflightBudgetBytes: 1 << 20 }, { logger: silent });
    await expect(receiver.receive('traces', encode(twoEntryTraces()), 'json', 'otlp/http')).rejects.toThrow(
      'disk full',
    );
    expect(receiver.stats().accepted.traces).toBe(2);
    expect(receiver.stats().rejected.traces).toBe(0);
  });

  test('a write failure propagates and counts nothing as rejected', async () => {
    const fake = fakeSession(false);
    const failing: WriterSession = {
      ...fake.session,
      async add() {
        throw new Error('disk full');
      },
    };
    const receiver = createReceiver(failing, { inflightBudgetBytes: 1 << 20 }, { logger: silent });
    await expect(
      receiver.receive('traces', encode(traceRequest([span()])), 'json', 'otlp/http'),
    ).rejects.toThrow('disk full');
    expect(receiver.stats().rejected).toEqual({ traces: 0, logs: 0, metrics: 0 });
  });
});
