import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { ExportTraceServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import { type Admission, createReceiver, type Receiver } from '../../src/receiver/receiver.js';
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
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
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

/** Claims `bytes` of the budget, asserting it was granted. */
function admitted(receiver: Receiver, bytes: number): Admission {
  const admission = receiver.admit(bytes);
  if (admission === null) throw new Error('expected the admission to be granted');
  return admission;
}

/** `receiver.receive` with an admission for the body's own length. */
function receive(
  receiver: Receiver,
  signal: Parameters<Receiver['receive']>[0],
  body: Uint8Array,
  encoding: Parameters<Receiver['receive']>[2],
  source: string,
) {
  return receiver.receive(signal, body, encoding, source, admitted(receiver, body.length));
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('createReceiver', () => {
  test('JSON traces with two entries of two spans', async () => {
    const w = createTestWriter();
    const { receiver, session } = await realReceiver(w);
    const r = await receive(receiver, 'traces', encode(twoEntryTraces()), 'json', 'otlp/http');
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
    const r = await receive(receiver, 'traces', body, 'protobuf', 'otlp/grpc');
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
    expect((await failure(receive(receiver, 'traces', body, 'protobuf', 'otlp/grpc'))).code).toBe(
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
    expect((await failure(receive(receiver, 'traces', body, 'protobuf', 'otlp/grpc'))).code).toBe(
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
    expect(await receive(receiver, 'logs', encode('{}'), 'json', 'otlp/http')).toEqual(empty);
    expect(await receive(receiver, 'logs', encode({ resourceLogs: [] }), 'json', 'otlp/http')).toEqual(empty);
    expect(await receive(receiver, 'traces', new Uint8Array(), 'protobuf', 'otlp/grpc')).toEqual(empty);
    const wrong = await failure(
      receive(receiver, 'traces', encode({ resourceLogs: [] }), 'json', 'otlp/http'),
    );
    expect(wrong.code).toBe('invalid-otlp');
    expect(wrong.message).toMatch(/expected resourceSpans/);
  });

  test('[empty, bad] is invalid-otlp, not a partial success', async () => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    const body = toBinary(
      ExportTraceServiceRequestSchema,
      create(ExportTraceServiceRequestSchema, {
        resourceSpans: [
          { scopeSpans: [] },
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: new Uint8Array(15).fill(3),
                    spanId: new Uint8Array(8).fill(3),
                    name: 's',
                    startTimeUnixNano: 1_700_000_000_000_000_000n,
                    endTimeUnixNano: 1_700_000_000_000_001_000n,
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect((await failure(receive(receiver, 'traces', body, 'protobuf', 't'))).code).toBe('invalid-otlp');
    expect(receiver.stats().refused.invalid).toBe(1);
  });

  test('[empty] alone succeeds with nothing', async () => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    const body = encode({ resourceSpans: [{ scopeSpans: [] }] });
    expect(await receive(receiver, 'traces', body, 'json', 't')).toEqual({
      accepted: 0,
      rejected: 0,
      errorMessage: null,
    });
    expect(Object.values(receiver.stats().refused).every((n) => n === 0)).toBe(true);
  });

  test('{} succeeds with nothing and is not a refusal', async () => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    expect(await receive(receiver, 'traces', encode('{}'), 'json', 't')).toEqual({
      accepted: 0,
      rejected: 0,
      errorMessage: null,
    });
    expect(Object.values(receiver.stats().refused).every((n) => n === 0)).toBe(true);
  });

  test.each(['[1,2]', 'not json'])('%s is invalid-otlp', async (text) => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    expect((await failure(receive(receiver, 'traces', encode(text), 'json', 'otlp/http'))).code).toBe(
      'invalid-otlp',
    );
  });

  test('budget: a second admission over the budget is refused while one is open, and not counted', () => {
    const receiver = createReceiver(
      fakeSession(false).session,
      { inflightBudgetBytes: 100 },
      { logger: silent },
    );
    const first = admitted(receiver, 10);
    expect(receiver.admit(100)).toBeNull();
    expect(receiver.stats().refused.busy).toBe(0);
    first.release();
    expect(receiver.admit(100)).not.toBeNull();
  });

  test('budget: a lone admission above the budget is granted, and grow never refuses it', () => {
    const receiver = createReceiver(
      fakeSession(false).session,
      { inflightBudgetBytes: 100 },
      { logger: silent },
    );
    const lone = admitted(receiver, 200);
    expect(lone.grow(500)).toBe(true);
    expect(lone.bytes).toBe(700);
  });

  test('budget: grow past the budget is refused (claiming nothing) while another admission is open', () => {
    const receiver = createReceiver(
      fakeSession(false).session,
      { inflightBudgetBytes: 100 },
      { logger: silent },
    );
    const first = admitted(receiver, 10);
    const second = admitted(receiver, 10);
    expect(second.grow(200)).toBe(false);
    expect(second.bytes).toBe(10);
    expect(second.grow(80)).toBe(true);
    first.release();
    expect(second.grow(500)).toBe(true);
  });

  test('budget: release is idempotent; stats.bytes is unaffected by admissions and counts bodies in receive', async () => {
    const receiver = createReceiver(
      fakeSession(false).session,
      { inflightBudgetBytes: 100 },
      { logger: silent },
    );
    const a = admitted(receiver, 60);
    a.grow(10);
    a.release();
    a.release();
    expect(receiver.stats().bytes).toBe(0);
    const body = encode(traceRequest([span()]));
    await receive(receiver, 'traces', body, 'json', 'a');
    expect(receiver.stats().bytes).toBe(body.length);
    const b = admitted(receiver, 100);
    expect(receiver.admit(1)).toBeNull();
    b.release();
  });

  test('budget: receive releases its admission on success and on failure', async () => {
    const receiver = createReceiver(
      fakeSession(false).session,
      { inflightBudgetBytes: 100 },
      { logger: silent },
    );
    await receive(receiver, 'traces', encode(traceRequest([span()])), 'json', 'a');
    await failure(receive(receiver, 'traces', encode('{not json'), 'json', 'b'));
    const hold = admitted(receiver, 100);
    expect(receiver.admit(100)).toBeNull();
    hold.release();
    expect(receiver.admit(100)).not.toBeNull();
  });

  test('receives are serialized: one request ends its input before the next adds', async () => {
    const fake = fakeSession(true);
    const receiver = createReceiver(fake.session, { inflightBudgetBytes: 1 << 20 }, { logger: silent });
    const body = encode(traceRequest([span()]));
    const a = receive(receiver, 'traces', body, 'json', 'a');
    const b = receive(receiver, 'traces', body, 'json', 'b');
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
    expect((await receive(receiver, 'traces', encode(at(0)), 'json', 'otlp/http')).accepted).toBe(1);
    expect((await receive(receiver, 'traces', encode(at(-hour)), 'json', 'otlp/http')).accepted).toBe(1);
    const late = await failure(receive(receiver, 'traces', encode(at(200 * day)), 'json', 'otlp/http'));
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
    const r = await receive(receiver, 'traces', encode({ resourceSpans }), 'json', 'otlp/http');
    expect(r.accepted).toBe(1);
    expect(r.rejected).toBe(1);
    expect(r.errorMessage).not.toBeNull();
  });

  test('close waits for the receive in progress; later receives are busy', async () => {
    const fake = fakeSession(true);
    const receiver = createReceiver(fake.session, { inflightBudgetBytes: 1 << 20 }, { logger: silent });
    const body = encode(traceRequest([span()]));
    let done = false;
    const inflight = receive(receiver, 'traces', body, 'json', 'a').then((r) => {
      done = true;
      return r;
    });
    await Promise.resolve();
    const closing = receiver.close().then(() => {
      expect(done).toBe(true);
    });
    expect((await failure(receive(receiver, 'traces', body, 'json', 'b'))).code).toBe('receiver-busy');
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
    await receive(receiver, 'traces', traces, 'json', 'otlp/http');
    await receive(receiver, 'logs', logs, 'json', 'otlp/http');
    const s = receiver.stats();
    expect(s.requests).toBe(2);
    expect(s.bytes).toBe(traces.length + logs.length);
    expect(s.accepted).toEqual({ traces: 4, logs: 1, metrics: 0 });
    expect(s.rejected).toEqual({ traces: 0, logs: 0, metrics: 0 });
  });

  test('stats count refused requests by outcome, and each counts as a request', async () => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    await failure(receive(receiver, 'traces', encode('{not json'), 'json', 'otlp/http'));
    await failure(receive(receiver, 'traces', encode('{not json'), 'json', 'otlp/http'));
    receiver.refused('unsupported', 'unsupported content-type text/plain');
    const s = receiver.stats();
    expect(s.requests).toBe(3);
    expect(s.refused).toEqual({
      invalid: 2,
      'too-large': 0,
      unsupported: 1,
      'not-found': 0,
      method: 0,
      busy: 0,
      internal: 0,
    });
  });

  test('a refused request after close counts as busy', async () => {
    const w = createTestWriter();
    const { receiver } = await realReceiver(w);
    await receiver.close();
    await failure(receive(receiver, 'traces', encode(traceRequest([span()])), 'json', 'otlp/http'));
    expect(receiver.stats().refused.busy).toBe(1);
    expect(receiver.stats().requests).toBe(1);
  });

  test('the first refusal of each kind is warned once', async () => {
    const warnings: string[] = [];
    const logger = { ...silent, warn: (m: string) => warnings.push(m) };
    const fake = fakeSession(false);
    const receiver = createReceiver(fake.session, { inflightBudgetBytes: 1 << 20 }, { logger });
    await failure(receive(receiver, 'traces', encode('{not json'), 'json', 'otlp/http'));
    await failure(receive(receiver, 'traces', encode('{not json'), 'json', 'otlp/http'));
    receiver.refused('unsupported', 'unsupported content-type text/plain');
    receiver.refused('unsupported', 'unsupported content-type text/html');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('invalid');
    expect(warnings[1]).toContain('unsupported');
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
    await expect(receive(receiver, 'traces', encode(twoEntryTraces()), 'json', 'otlp/http')).rejects.toThrow(
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
      receive(receiver, 'traces', encode(traceRequest([span()])), 'json', 'otlp/http'),
    ).rejects.toThrow('disk full');
    expect(receiver.stats().rejected).toEqual({ traces: 0, logs: 0, metrics: 0 });
  });
});
