import type { AnyValue, Attributes } from './anyvalue.js';
import type { RelNanos, SpanId, TraceId } from './ids.js';

export {
  Span_SpanKind as SpanKind,
  Status_StatusCode as StatusCode,
} from './gen/opentelemetry/proto/trace/v1/trace_pb.js';

import type {
  Span_SpanKind as SpanKind,
  Status_StatusCode as StatusCode,
} from './gen/opentelemetry/proto/trace/v1/trace_pb.js';

declare const brand: unique symbol;
export type ResourceRef = number & { readonly [brand]: 'ResourceRef' };
export type ScopeRef = number & { readonly [brand]: 'ScopeRef' };

export interface ResourceRecord {
  readonly attributes: Attributes;
  readonly droppedAttributesCount: number;
  readonly schemaUrl: string;
}

export interface ScopeRecord {
  readonly name: string;
  readonly version: string;
  readonly attributes: Attributes;
  readonly droppedAttributesCount: number;
  readonly schemaUrl: string;
}

export interface SpanEventRecord {
  readonly time: RelNanos;
  readonly name: string;
  readonly attributes: Attributes;
  readonly droppedAttributesCount: number;
}

export interface SpanLinkRecord {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly traceState: string;
  readonly attributes: Attributes;
  readonly droppedAttributesCount: number;
  readonly flags: number;
}

export interface SpanRecord {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId: SpanId | null;
  readonly traceState: string;
  readonly flags: number;
  readonly name: string;
  readonly kind: SpanKind;
  readonly start: RelNanos;
  readonly end: RelNanos;
  readonly attributes: Attributes;
  readonly droppedAttributesCount: number;
  readonly events: readonly SpanEventRecord[];
  readonly droppedEventsCount: number;
  readonly links: readonly SpanLinkRecord[];
  readonly droppedLinksCount: number;
  readonly status: { readonly code: StatusCode; readonly message: string };
  readonly resource: ResourceRef;
  readonly scope: ScopeRef;
}

export interface LogRecordRecord {
  readonly time: RelNanos | null;
  readonly observedTime: RelNanos | null;
  readonly severityNumber: number;
  readonly severityText: string;
  readonly body: AnyValue;
  readonly attributes: Attributes;
  readonly droppedAttributesCount: number;
  readonly flags: number;
  readonly traceId: TraceId | null;
  readonly spanId: SpanId | null;
  readonly eventName: string;
  readonly resource: ResourceRef;
  readonly scope: ScopeRef;
}

export interface MetricPointRecord {
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly type: 'gauge' | 'sum' | 'histogram' | 'exponentialHistogram' | 'summary';
  readonly temporality: 'unspecified' | 'delta' | 'cumulative';
  readonly monotonic: boolean;
  readonly start: RelNanos | null;
  readonly time: RelNanos;
  readonly attributes: Attributes;
  readonly flags: number;
  /** Point-kind-specific JSON (incl. exemplars), kept verbatim. */
  readonly point: unknown;
  readonly resource: ResourceRef;
  readonly scope: ScopeRef;
}
