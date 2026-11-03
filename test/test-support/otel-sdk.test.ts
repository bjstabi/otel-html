import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  inMemoryTracing,
  reporting,
  startTestSdk,
  stderrOnce,
  type TestTracing,
  tracingEnabled,
  VIEWER_RESOURCE,
} from '../../test-support/otel/sdk.js';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const ENDPOINT = 'http://127.0.0.1:9';
let started: TestTracing | undefined;

afterEach(async () => {
  await started?.shutdown();
  started = undefined;
  trace.disable();
  context.disable();
  propagation.disable();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The simple processor exports on a microtask; wait for the spans to arrive. */
async function finished(exporter: InMemorySpanExporter, count = 1): Promise<ReadableSpan[]> {
  await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(count));
  return exporter.getFinishedSpans();
}

function inject(env: Record<string, string | undefined> = {}): {
  tracing: TestTracing;
  exporter: InMemorySpanExporter;
} {
  const exporter = new InMemorySpanExporter();
  const tracing = startTestSdk(env, 'vitest', { exporter, processor: 'simple' });
  if (tracing === undefined) throw new Error('SDK did not start');
  started = tracing;
  return { tracing, exporter };
}

describe('test SDK', () => {
  test('starts nothing without an endpoint', () => {
    expect(startTestSdk({}, 'vitest')).toBeUndefined();
    expect(startTestSdk({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }, 'vitest')).toBeUndefined();
    expect(tracingEnabled({})).toBe(false);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: '' })).toBe(false);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT })).toBe(true);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ENDPOINT })).toBe(true);
  });

  test('starts nothing when OTEL_SDK_DISABLED is true', () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, OTEL_SDK_DISABLED: 'true' };
    expect(startTestSdk(env, 'vitest')).toBeUndefined();
    expect(tracingEnabled(env)).toBe(false);
  });

  test('parents to TRACEPARENT', async () => {
    const { tracing, exporter } = inject();
    const span = tracing.tracer.startSpan('child', {}, tracing.parentFrom({ TRACEPARENT }));
    span.end();
    const [done] = await finished(exporter);
    expect(done?.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(done?.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
  });

  test('a malformed TRACEPARENT starts a fresh trace', async () => {
    const { tracing, exporter } = inject();
    const parent = tracing.parentFrom({ TRACEPARENT: 'garbage' });
    tracing.tracer.startSpan('fresh', {}, parent).end();
    const [done] = await finished(exporter);
    expect(done?.parentSpanContext).toBeUndefined();
    expect(done?.spanContext().traceId).not.toBe('0af7651916cd43dd8448eb211c80319c');
  });

  test('uses otel-html-tests unless OTEL_HTML_TEST_SERVICE_NAME is set', async () => {
    vi.stubEnv('OTEL_SERVICE_NAME', 'mise');
    const { tracing, exporter } = inject({ OTEL_SERVICE_NAME: 'mise' });
    tracing.tracer.startSpan('a').end();
    const [a] = await finished(exporter);
    expect(a?.resource.attributes['service.name']).toBe('otel-html-tests');
    expect(a?.resource.attributes['test.framework']).toBe('vitest');
  });

  test('OTEL_HTML_TEST_SERVICE_NAME and the framework go on the resource', async () => {
    const exporter = new InMemorySpanExporter();
    started = startTestSdk({ OTEL_SERVICE_NAME: 'mise', OTEL_HTML_TEST_SERVICE_NAME: 'x' }, 'playwright', {
      exporter,
      processor: 'simple',
    });
    started?.tracer.startSpan('b').end();
    const [b] = await finished(exporter);
    expect(b?.resource.attributes['service.name']).toBe('x');
    expect(b?.resource.attributes['test.framework']).toBe('playwright');
  });

  test('reporting writes one stderr line across failures and passes results through', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const failed = { code: ExportResultCode.FAILED, error: new Error('boom') };
    const results: ExportResult[] = [];
    const failing: SpanExporter = {
      export: (_spans, done) => done(failed),
      shutdown: () => Promise.resolve(),
    };
    const throwing: SpanExporter = {
      export: () => {
        throw new Error('sync');
      },
      shutdown: () => Promise.resolve(),
    };
    const warn = stderrOnce();
    reporting(failing, warn).export([], (r) => results.push(r));
    reporting(throwing, warn).export([], (r) => results.push(r));
    expect(results.map((r) => r.code)).toEqual([ExportResultCode.FAILED, ExportResultCode.FAILED]);
    expect(results[0]).toBe(failed);
    expect(stderr.mock.calls).toEqual([['otel-html tests: span export failed: boom\n']]);
  });

  test('inMemoryTracing registers nothing globally', async () => {
    const { tracing, exporter } = inMemoryTracing();
    expect(trace.getTracer('x').startSpan('s').isRecording()).toBe(false);
    tracing.tracer.startSpan('mine').end();
    await finished(exporter);
    expect(tracing.parentFrom({})).toBe(ROOT_CONTEXT);
    const parent = tracing.parentFrom({ TRACEPARENT });
    expect(trace.getSpanContext(parent)?.spanId).toBe('b7ad6b7169203331');
  });

  test('record() exports a foreign span', async () => {
    const { tracing, exporter } = inject();
    const span: ReadableSpan = {
      name: 'viewer.render',
      kind: SpanKind.INTERNAL,
      spanContext: () => ({
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: '1111111111111111',
        traceFlags: 1,
      }),
      startTime: [1, 0],
      endTime: [2, 0],
      duration: [1, 0],
      status: { code: 0 },
      attributes: {},
      links: [],
      events: [],
      ended: true,
      resource: VIEWER_RESOURCE,
      instrumentationScope: { name: 'viewer' },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
    tracing.record(span);
    expect(await finished(exporter)).toEqual([span]);
    expect(VIEWER_RESOURCE.attributes['service.name']).toBe('otel-html-viewer');
    expect(resourceFromAttributes({}).attributes).toEqual({});
  });

  test('shutdown resolves within the cap against an unreachable endpoint', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    started = startTestSdk({ OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT }, 'vitest');
    expect(started).toBeDefined();
    started?.tracer.startSpan('lost').end();
    const t0 = Date.now();
    await expect(started?.shutdown()).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(stderr.mock.calls.length).toBeLessThanOrEqual(1);
  }, 10_000);
});
