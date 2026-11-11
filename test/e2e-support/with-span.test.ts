import { SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withSpan } from '../../e2e/otel.js';
import { withOwnOtelGlobals } from '../../test-support/otel/own-globals.js';
import { startTestSdk } from '../../test-support/otel/sdk.js';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const PARENT_ID = 'b7ad6b7169203331';
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Runs `body` with a started test SDK that exports to memory, under the job's TRACEPARENT. */
function withTracing(
  body: (
    tracing: NonNullable<ReturnType<typeof startTestSdk>>,
    exporter: InMemorySpanExporter,
  ) => Promise<void>,
): Promise<void> {
  return withOwnOtelGlobals(async () => {
    vi.stubEnv('TRACEPARENT', TRACEPARENT);
    const exporter = new InMemorySpanExporter();
    const tracing = startTestSdk({ TRACEPARENT }, 'playwright', { exporter, processor: 'simple' });
    if (tracing === undefined) throw new Error('SDK did not start');
    try {
      await body(tracing, exporter);
    } finally {
      await tracing.shutdown();
    }
  });
}

describe('withSpan', () => {
  it('runs fn inside a span of the job trace and returns its value', () =>
    withTracing(async (tracing, exporter) => {
      const value = await withSpan(tracing, 'metrics scale report', async () => {
        trace.getTracer('t').startSpan('child').end();
        return 7;
      });
      expect(value).toBe(7);
      await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(2));
      const spans = exporter.getFinishedSpans();
      const span = spans.find((s) => s.name === 'metrics scale report');
      const child = spans.find((s) => s.name === 'child');
      expect(span?.spanContext().traceId).toBe(TRACE_ID);
      expect(span?.parentSpanContext?.spanId).toBe(PARENT_ID);
      expect(child?.parentSpanContext?.spanId).toBe(span?.spanContext().spanId);
    }));

  it('records a rejection on the span, rethrows it and ends the span', () =>
    withTracing(async (tracing, exporter) => {
      const error = new Error('boom');
      await expect(withSpan(tracing, 'failing', () => Promise.reject(error))).rejects.toBe(error);
      await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(1));
      expect(exporter.getFinishedSpans()[0]?.status).toMatchObject({
        code: SpanStatusCode.ERROR,
        message: 'boom',
      });
    }));

  it('is fn itself without tracing', async () => {
    await expect(withSpan(undefined, 'x', async () => 1)).resolves.toBe(1);
  });
});
