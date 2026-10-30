import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { startReceiver } from '../../src/api/receiver.js';
import { Report } from '../../src/api/report.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { createTestWriter } from '../../test-support/writer-deps.js';
import { allSpans, manifestOf, spansRequest } from '../writer/helpers.js';

const running: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.close()));
});

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

const BOTH = { http: { port: 0 }, grpc: { port: 0 } };

describe('startReceiver', () => {
  test('binds both transports on real ports and lands posted spans in the report', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const rx = await startReceiver(report, BOTH, w.deps);
    running.push(rx);
    expect(rx.http).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
    expect(rx.grpc).toMatch(/^127\.0\.0\.1:[1-9]\d*$/);

    const res = await fetch(`${rx.http}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spansRequest(3)),
    });
    expect(res.status).toBe(200);
    expect(rx.stats().requests).toBe(1);
    expect(rx.stats().accepted.traces).toBe(3);

    await rx.close();
    await report.close();
    expect(manifestOf(w, 'r').totals.spans).toBe(3);
    expect(allSpans(w, 'r')).toHaveLength(3);
  });

  test('both transports disabled is a usage error', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const e = await failure(startReceiver(report, { http: false, grpc: false }, w.deps));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('no receiver transport enabled');
    expect(e.hint).toBe('enable http or grpc');
    await report.close();
  });

  test('config enabled: false is honoured without an override, and an object override beats it', async () => {
    const w = createTestWriter();
    const report = await Report.create(
      { out: 'r', config: { receiver: { grpc: { enabled: false } } } },
      w.deps,
    );
    const rx = await startReceiver(report, { http: { port: 0 } }, w.deps);
    running.push(rx);
    expect(rx.grpc).toBeNull();
    expect(rx.http).not.toBeNull();
    await rx.close();

    const again = await startReceiver(report, BOTH, w.deps);
    running.push(again);
    expect(again.grpc).not.toBeNull();
    await again.close();
    await report.close();
  });

  test('closes the HTTP listener when the gRPC bind fails', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const first = await startReceiver(report, { http: false, grpc: { port: 0 } }, w.deps);
    running.push(first);
    const taken = Number(first.grpc?.split(':').at(-1));
    const probe = createServer();
    await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok));
    const free = (probe.address() as AddressInfo).port;
    await new Promise<void>((ok) => probe.close(() => ok()));

    await expect(
      startReceiver(report, { http: { port: free }, grpc: { port: taken } }, w.deps),
    ).rejects.toBeInstanceOf(Error);
    const span = w.spans.filter((s) => s.name === 'otel-html.receive').at(-1);
    expect(span?.ended).toBe(true);
    expect(span?.error).toBeDefined();

    // The HTTP port is free again: the listener bound before the failure was closed.
    const again = await startReceiver(report, { http: { port: free }, grpc: false }, w.deps);
    running.push(again);
    expect(again.http).toBe(`http://127.0.0.1:${free}`);
    await again.close();
    await first.close();
    await report.close();
  });

  test('the otel-html.receive span carries the stats once closed', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const rx = await startReceiver(report, { http: { port: 0 }, grpc: false }, w.deps);
    running.push(rx);
    await fetch(`${rx.http}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spansRequest(2)),
    });
    const span = w.spans.find((s) => s.name === 'otel-html.receive');
    expect(span?.ended).toBe(false);
    await rx.close();
    expect(span?.ended).toBe(true);
    expect(span?.attrs).toMatchObject({ requests: 1, bytes: expect.any(Number) });
    await report.close();
  });
});
