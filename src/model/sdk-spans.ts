import { create } from '@bufbuild/protobuf';
import type { Attributes, HrTime } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  type ExportTraceServiceRequest,
  ExportTraceServiceRequestSchema,
} from './gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import {
  type AnyValue,
  AnyValueSchema,
  type KeyValue,
  KeyValueSchema,
} from './gen/opentelemetry/proto/common/v1/common_pb.js';
import { ResourceSchema } from './gen/opentelemetry/proto/resource/v1/resource_pb.js';
import {
  type ResourceSpans,
  ResourceSpansSchema,
  type ScopeSpans,
  ScopeSpansSchema,
  type Span,
  type Span_Event,
  Span_EventSchema,
  type Span_Link,
  Span_LinkSchema,
  type Span_SpanKind,
  SpanSchema,
  Status_StatusCode,
  StatusSchema,
} from './gen/opentelemetry/proto/trace/v1/trace_pb.js';

const HAS_IS_REMOTE = 0x100;
const IS_REMOTE = 0x200;

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function hrToNanos(t: HrTime): bigint {
  return BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]);
}

function flagsFrom(traceFlags: number, isRemote: boolean | undefined): number {
  return (traceFlags & 0xff) | HAS_IS_REMOTE | (isRemote ? IS_REMOTE : 0);
}

export function anyValueOf(v: unknown): AnyValue {
  if (typeof v === 'string') return create(AnyValueSchema, { value: { case: 'stringValue', value: v } });
  if (typeof v === 'boolean') return create(AnyValueSchema, { value: { case: 'boolValue', value: v } });
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? create(AnyValueSchema, { value: { case: 'intValue', value: BigInt(v) } })
      : create(AnyValueSchema, { value: { case: 'doubleValue', value: v } });
  }
  if (v instanceof Uint8Array) return create(AnyValueSchema, { value: { case: 'bytesValue', value: v } });
  if (Array.isArray(v)) {
    return create(AnyValueSchema, {
      value: { case: 'arrayValue', value: { values: v.map(anyValueOf) } },
    });
  }
  if (typeof v === 'object' && v !== null) {
    return create(AnyValueSchema, {
      value: { case: 'kvlistValue', value: { values: Object.entries(v).map(([k, x]) => kv(k, x)) } },
    });
  }
  return create(AnyValueSchema, {});
}

function kv(key: string, value: unknown): KeyValue {
  return create(KeyValueSchema, { key, value: anyValueOf(value) });
}

export function attributesToKeyValues(attrs: Attributes): KeyValue[] {
  return Object.entries(attrs).map(([k, v]) => kv(k, v));
}

function toEvent(e: ReadableSpan['events'][number]): Span_Event {
  return create(Span_EventSchema, {
    timeUnixNano: hrToNanos(e.time),
    name: e.name,
    attributes: e.attributes ? attributesToKeyValues(e.attributes) : [],
    droppedAttributesCount: e.droppedAttributesCount ?? 0,
  });
}

function toLink(l: ReadableSpan['links'][number]): Span_Link {
  return create(Span_LinkSchema, {
    traceId: hexToBytes(l.context.traceId),
    spanId: hexToBytes(l.context.spanId),
    traceState: l.context.traceState?.serialize() ?? '',
    attributes: l.attributes ? attributesToKeyValues(l.attributes) : [],
    droppedAttributesCount: l.droppedAttributesCount ?? 0,
    flags: flagsFrom(l.context.traceFlags, l.context.isRemote),
  });
}

// SDK SpanStatusCode (UNSET=0, OK=1, ERROR=2) numerically matches OTLP StatusCode.
function statusCode(code: number): Status_StatusCode {
  switch (code) {
    case 1:
      return Status_StatusCode.OK;
    case 2:
      return Status_StatusCode.ERROR;
    default:
      return Status_StatusCode.UNSET;
  }
}

function toSpan(s: ReadableSpan): Span {
  const ctx = s.spanContext();
  const parent = s.parentSpanContext;
  return create(SpanSchema, {
    traceId: hexToBytes(ctx.traceId),
    spanId: hexToBytes(ctx.spanId),
    parentSpanId: parent?.spanId ? hexToBytes(parent.spanId) : new Uint8Array(),
    traceState: ctx.traceState?.serialize() ?? '',
    name: s.name,
    // SDK SpanKind is 0-based (INTERNAL=0); OTLP reserves 0 for UNSPECIFIED.
    kind: (s.kind + 1) as Span_SpanKind,
    startTimeUnixNano: hrToNanos(s.startTime),
    endTimeUnixNano: hrToNanos(s.endTime),
    attributes: attributesToKeyValues(s.attributes),
    droppedAttributesCount: s.droppedAttributesCount,
    events: s.events.map(toEvent),
    droppedEventsCount: s.droppedEventsCount,
    links: s.links.map(toLink),
    droppedLinksCount: s.droppedLinksCount,
    // SDK SpanStatusCode (UNSET=0, OK=1, ERROR=2) matches OTLP StatusCode values.
    status: create(StatusSchema, {
      code: statusCode(s.status.code),
      message: s.status.message ?? '',
    }),
    flags: flagsFrom(ctx.traceFlags, parent?.isRemote),
  });
}

/** Group SDK spans by resource, then by instrumentation scope, preserving first-seen order. */
export function readableSpansToRequest(spans: readonly ReadableSpan[]): ExportTraceServiceRequest {
  const byResource = new Map<ReadableSpan['resource'], Map<string, ReadableSpan[]>>();
  for (const s of spans) {
    let scopes = byResource.get(s.resource);
    if (!scopes) {
      scopes = new Map();
      byResource.set(s.resource, scopes);
    }
    const sc = s.instrumentationScope;
    const key = JSON.stringify([sc.name, sc.version ?? '', sc.schemaUrl ?? '']);
    const list = scopes.get(key);
    if (list) list.push(s);
    else scopes.set(key, [s]);
  }

  const resourceSpans: ResourceSpans[] = [];
  for (const [resource, scopes] of byResource) {
    const scopeSpans: ScopeSpans[] = [];
    for (const list of scopes.values()) {
      const first = list[0];
      if (!first) continue;
      const sc = first.instrumentationScope;
      scopeSpans.push(
        create(ScopeSpansSchema, {
          scope: { name: sc.name, version: sc.version ?? '' },
          spans: list.map(toSpan),
          schemaUrl: sc.schemaUrl ?? '',
        }),
      );
    }
    resourceSpans.push(
      create(ResourceSpansSchema, {
        resource: create(ResourceSchema, { attributes: attributesToKeyValues(resource.attributes) }),
        scopeSpans,
        schemaUrl: resource.schemaUrl ?? '',
      }),
    );
  }
  return create(ExportTraceServiceRequestSchema, { resourceSpans });
}
