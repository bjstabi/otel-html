import { fromJson, toJson } from '@bufbuild/protobuf';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { ExportTraceServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import { readableSpansToRequest } from '../../src/model/sdk-spans.js';

function collectSpans(): ReadableSpan[] {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'svc', 'service.version': '1.2.3' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const a = provider.getTracer('scope-a', '1.0.0');
  const b = provider.getTracer('scope-b', '2.0.0', { schemaUrl: 'https://example.com/schema' });

  const parent = a.startSpan('parent', {
    kind: SpanKind.SERVER,
    attributes: {
      s: 'str',
      i: 42,
      d: 1.5,
      t: true,
      sa: ['x', 'y'],
      ia: [1, 2, 3],
      da: [0.5, 1.5],
      ba: [true, false],
    },
  });
  const child = a.startSpan('child', { kind: SpanKind.CLIENT }, trace.setSpan(ROOT_CONTEXT, parent));
  child.addEvent('evt', { 'e.k': 'v', 'e.n': 3 }, [1700000000, 5]);
  child.end();

  const linked = b.startSpan('linked', {
    links: [{ context: parent.spanContext(), attributes: { 'l.k': 'v' } }],
  });
  linked.setStatus({ code: SpanStatusCode.ERROR, message: 'boom' });
  linked.end();

  const b2 = b.startSpan('b-second', { kind: SpanKind.PRODUCER });
  b2.setStatus({ code: SpanStatusCode.OK });
  b2.end();
  const a2 = a.startSpan('a-second', { kind: SpanKind.CONSUMER });
  a2.end();
  parent.end();
  return exporter.getFinishedSpans();
}

const ID_KEYS = new Set(['traceId', 'spanId', 'parentSpanId']);

// The upstream serializer emits OTLP/JSON hex ids; protobuf-es JSON uses base64 for bytes.
function hexIdsToBase64(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(hexIdsToBase64);
  if (typeof v !== 'object' || v === null) return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [
      k,
      ID_KEYS.has(k) && typeof x === 'string' ? Buffer.from(x, 'hex').toString('base64') : hexIdsToBase64(x),
    ]),
  );
}

describe('readableSpansToRequest', () => {
  it('matches the upstream OTLP JSON serializer', () => {
    const spans = collectSpans();
    const actual = toJson(ExportTraceServiceRequestSchema, readableSpansToRequest(spans));
    const oracle: unknown = JSON.parse(new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans)));
    const expected = toJson(
      ExportTraceServiceRequestSchema,
      fromJson(ExportTraceServiceRequestSchema, hexIdsToBase64(oracle) as never),
    );
    expect(actual).toEqual(expected);
  });

  it('groups by scope preserving order and carries parent, event, link and error status', () => {
    const req = readableSpansToRequest(collectSpans());
    expect(req.resourceSpans).toHaveLength(1);
    const scopes = req.resourceSpans.flatMap((r) => r.scopeSpans);
    expect(scopes.map((x) => x.scope?.name)).toEqual(['scope-a', 'scope-b']);
    const all = scopes.flatMap((x) => x.spans);
    const child = all.find((x) => x.name === 'child');
    const parent = all.find((x) => x.name === 'parent');
    expect(child?.parentSpanId).toEqual(parent?.spanId);
    expect(child?.events).toHaveLength(1);
    expect(all.find((x) => x.name === 'linked')?.links).toHaveLength(1);
    expect(all.find((x) => x.name === 'linked')?.status?.message).toBe('boom');
  });

  it('returns an empty request for no spans', () => {
    expect(readableSpansToRequest([]).resourceSpans).toEqual([]);
  });
});
