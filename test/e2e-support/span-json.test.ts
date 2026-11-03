import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { expect, it, vi } from 'vitest';
import { fromSpanJson, toSpanJson } from '../../e2e/otel-page/span-json.js';
import { VIEWER_RESOURCE } from '../../test-support/otel/sdk.js';

it('round-trips a finished span through JSON', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer('otel-html-viewer', '1.2.3');
  const parent = tracer.startSpan('parent');
  const child = tracer.startSpan(
    'child',
    { kind: SpanKind.CLIENT, attributes: { a: 'x', n: 2, b: true, list: ['p', 'q'] } },
    trace.setSpan(ROOT_CONTEXT, parent),
  );
  child.addEvent('boom', { 'exception.message': 'bad' });
  child.setStatus({ code: SpanStatusCode.ERROR, message: 'failed' });
  child.end();
  parent.end();
  await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(2));
  const original = exporter.getFinishedSpans().find((s) => s.name === 'child');
  if (original === undefined) throw new Error('no child span');

  const json: unknown = JSON.parse(JSON.stringify(toSpanJson(original)));
  const rebuilt = fromSpanJson(json as ReturnType<typeof toSpanJson>, VIEWER_RESOURCE);

  expect(rebuilt.spanContext()).toEqual(original.spanContext());
  expect(rebuilt.parentSpanContext?.spanId).toBe(original.parentSpanContext?.spanId);
  expect(rebuilt.name).toBe('child');
  expect(rebuilt.kind).toBe(SpanKind.CLIENT);
  expect(rebuilt.startTime).toEqual(original.startTime);
  expect(rebuilt.endTime).toEqual(original.endTime);
  expect(rebuilt.attributes).toEqual({ a: 'x', n: 2, b: true, list: ['p', 'q'] });
  expect(rebuilt.status).toEqual({ code: SpanStatusCode.ERROR, message: 'failed' });
  expect(rebuilt.events.map((e) => [e.name, e.attributes])).toEqual([
    ['boom', { 'exception.message': 'bad' }],
  ]);
  expect(rebuilt.instrumentationScope).toMatchObject({ name: 'otel-html-viewer', version: '1.2.3' });
  expect(rebuilt.resource.attributes['service.name']).toBe('otel-html-viewer');
});
