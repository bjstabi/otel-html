import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { afterEach, expect, vi, test as vitestTest } from 'vitest';
import { withOwnOtelGlobals } from '../../test-support/otel/own-globals.js';
import { startTestSdk, type TestTracing } from '../../test-support/otel/sdk.js';

let started: TestTracing | undefined;

// Same shape as otel-sdk.test.ts: vitest's own OTel globals are set aside for the test and put back.
const test = (name: string, fn: (sdk: TestTracing, exporter: InMemorySpanExporter) => unknown) =>
  vitestTest(name, () =>
    withOwnOtelGlobals(async () => {
      const exporter = new InMemorySpanExporter();
      const sdk = startTestSdk({}, 'vitest', { exporter, processor: 'simple' });
      if (sdk === undefined) throw new Error('SDK did not start');
      started = sdk;
      try {
        await fn(sdk, exporter);
      } finally {
        vi.useRealTimers();
        await started?.shutdown();
        started = undefined;
      }
    }),
  );

afterEach(() => {
  vi.useRealTimers();
});

const ms = (t: readonly [number, number]): number => t[0] * 1_000 + t[1] / 1e6;

async function finished(exporter: InMemorySpanExporter, count: number): Promise<ReadableSpan[]> {
  await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(count), { timeout: 2_000 });
  return exporter.getFinishedSpans();
}

test('a span started and ended under a faked clock keeps real times', async (sdk, exporter) => {
  const before = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2001-01-01T00:00:00Z'));
  const span = sdk.tracer.startSpan('faked');
  vi.advanceTimersByTime(86_400_000);
  span.end();
  vi.useRealTimers();
  const [s] = await finished(exporter, 1);
  expect(s).toBeDefined();
  if (s === undefined) return;
  expect(ms(s.startTime)).toBeGreaterThanOrEqual(before - 5);
  expect(ms(s.endTime)).toBeGreaterThanOrEqual(ms(s.startTime));
  expect(ms(s.endTime) - before).toBeLessThan(5_000);
});

test('a child span under a faked clock starts inside its parent', async (sdk, exporter) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2001-01-01T00:00:00Z'));
  const parent = sdk.tracer.startSpan('parent');
  vi.setSystemTime(new Date('2002-01-01T00:00:00Z'));
  const child = sdk.tracer.startSpan('child', {}, trace.setSpan(context.active(), parent));
  vi.advanceTimersByTime(1_000);
  child.end();
  parent.end();
  vi.useRealTimers();
  const spans = await finished(exporter, 2);
  const p = spans.find((x) => x.name === 'parent');
  const c = spans.find((x) => x.name === 'child');
  if (p === undefined || c === undefined) throw new Error('missing span');
  expect(c.parentSpanContext?.spanId).toBe(p.spanContext().spanId);
  expect(ms(c.startTime)).toBeGreaterThanOrEqual(ms(p.startTime));
  expect(ms(c.endTime)).toBeLessThanOrEqual(ms(p.endTime));
});

test('an event and an exception added under a faked clock keep real times', async (sdk, exporter) => {
  const before = Date.now();
  const span = sdk.tracer.startSpan('with events');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2001-01-01T00:00:00Z'));
  span.addEvent('plain');
  span.addEvent('with attributes', { a: 1 });
  span.recordException(new Error('boom'));
  span.end();
  vi.useRealTimers();
  const [s] = await finished(exporter, 1);
  if (s === undefined) throw new Error('missing span');
  expect(s.events.map((e) => e.name)).toEqual(['plain', 'with attributes', 'exception']);
  for (const e of s.events) {
    expect(ms(e.time)).toBeGreaterThanOrEqual(before - 5);
    expect(ms(e.time)).toBeLessThanOrEqual(ms(s.endTime));
  }
});

test('a tracer from the global API, as vitest gets its own, keeps real times', async (_sdk, exporter) => {
  const before = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2001-01-01T00:00:00Z'));
  trace.getTracer('vitest').startActiveSpan('global', (span) => {
    vi.advanceTimersByTime(1_000);
    span.end();
  });
  vi.useRealTimers();
  const [s] = await finished(exporter, 1);
  if (s === undefined) throw new Error('missing span');
  expect(ms(s.startTime)).toBeGreaterThanOrEqual(before - 5);
  expect(ms(s.endTime) - before).toBeLessThan(5_000);
});
