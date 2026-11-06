import type { RelNanos, UnixNanos } from '../../model/ids.js';
import type {
  LogRecordRecord,
  MetricPointRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
  SpanRecord,
} from '../../model/records.js';
import { ATTR_HOST_NAME } from '../../semconv/attributes.js';
import { resourceName, serviceName } from '../../semconv/resource-name.js';
import { anyValueJson, attributesToJson, attributesToJsonValue, type JsonValue } from '../columns.js';

/** One record as a table row, keyed by column name (see `schema.ts`): bigint for int64 columns, JSON text for json. */
export type Row = Record<string, unknown>;

export interface Context {
  readonly epoch: UnixNanos;
  readonly resources: (r: ResourceRef) => ResourceRecord;
  readonly scopes: (s: ScopeRef) => ScopeRecord;
}

/** The metric normalization columns of a point, passed through to the row unchanged. */
export interface PointNormalization {
  readonly deltaValue: number | null;
  readonly deltaCount: number | null;
  readonly reset: boolean;
  readonly outOfOrder: boolean;
  readonly seriesId: string;
}

/** A report-relative time as absolute unix nanoseconds: `epoch + t`. */
export function absolute(t: RelNanos, epoch: UnixNanos): bigint {
  return epoch + BigInt(t);
}

function absoluteOrNull(t: RelNanos | null, epoch: UnixNanos): bigint | null {
  return t === null ? null : absolute(t, epoch);
}

const TEMPORALITY_NUMBER = { unspecified: 0, delta: 1, cumulative: 2 } as const;

function resourceAndScope(resource: ResourceRecord, scope: ScopeRecord): Row {
  return {
    resource_attributes: attributesToJson(resource.attributes),
    resource_schema_url: resource.schemaUrl,
    resource_dropped_attributes_count: resource.droppedAttributesCount,
    scope_name: scope.name,
    scope_version: scope.version,
    scope_attributes: attributesToJson(scope.attributes),
    scope_schema_url: scope.schemaUrl,
    scope_dropped_attributes_count: scope.droppedAttributesCount,
  };
}

export function spanRow(span: SpanRecord, ctx: Context): Row {
  const resource = ctx.resources(span.resource);
  const scope = ctx.scopes(span.scope);
  const start = absolute(span.start, ctx.epoch);
  const end = absolute(span.end, ctx.epoch);
  const events: JsonValue[] = span.events.map((e) => ({
    time_unix_nano: { $i: absolute(e.time, ctx.epoch).toString() },
    name: e.name,
    attributes: attributesToJsonValue(e.attributes),
    dropped_attributes_count: e.droppedAttributesCount,
  }));
  const links: JsonValue[] = span.links.map((l) => ({
    trace_id: l.traceId,
    span_id: l.spanId,
    trace_state: l.traceState,
    attributes: attributesToJsonValue(l.attributes),
    dropped_attributes_count: l.droppedAttributesCount,
    flags: l.flags,
  }));
  return {
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    trace_state: span.traceState,
    flags: span.flags,
    name: span.name,
    kind: span.kind,
    start_time_unix_nano: start,
    end_time_unix_nano: end,
    duration_ns: end > start ? end - start : 0n,
    status_code: span.status.code,
    status_message: span.status.message,
    dropped_attributes_count: span.droppedAttributesCount,
    dropped_events_count: span.droppedEventsCount,
    dropped_links_count: span.droppedLinksCount,
    attributes: attributesToJson(span.attributes),
    events: JSON.stringify(events),
    links: JSON.stringify(links),
    ...resourceAndScope(resource, scope),
    service_name: serviceName(resource),
    resource_name: resourceName(span),
  };
}

function hostName(resource: ResourceRecord): string | null {
  const v = resource.attributes.get(ATTR_HOST_NAME);
  return v?.kind === 'string' && v.value !== '' ? v.value : null;
}

export function logRow(log: LogRecordRecord, ctx: Context): Row {
  const resource = ctx.resources(log.resource);
  const scope = ctx.scopes(log.scope);
  return {
    time_unix_nano: absoluteOrNull(log.time, ctx.epoch),
    observed_time_unix_nano: absoluteOrNull(log.observedTime, ctx.epoch),
    severity_number: log.severityNumber,
    severity_text: log.severityText,
    event_name: log.eventName === '' ? null : log.eventName,
    body: anyValueJson(log.body),
    attributes: attributesToJson(log.attributes),
    dropped_attributes_count: log.droppedAttributesCount,
    flags: log.flags,
    trace_id: log.traceId,
    span_id: log.spanId,
    ...resourceAndScope(resource, scope),
    service_name: serviceName(resource),
    host_name: hostName(resource),
  };
}

function pointField(point: unknown, key: string): string | null {
  if (typeof point !== 'object' || point === null) return null;
  const v: unknown = Object.getOwnPropertyDescriptor(point, key)?.value;
  return v === undefined ? null : JSON.stringify(v);
}

/**
 * A metric point's row: identity, time, attributes, resource/scope and the normalization columns. The kind-specific
 * value columns (value_double, buckets, ...) are filled by the point encoder (Task 5.1); `exemplars` and `quantiles`
 * are taken verbatim from the point's JSON.
 */
export function pointRow(point: MetricPointRecord, norm: PointNormalization, ctx: Context): Row {
  const resource = ctx.resources(point.resource);
  const scope = ctx.scopes(point.scope);
  return {
    metric_name: point.name,
    metric_description: point.description,
    metric_unit: point.unit,
    point_type: point.type,
    aggregation_temporality: TEMPORALITY_NUMBER[point.temporality],
    is_monotonic: point.monotonic,
    start_time_unix_nano: absoluteOrNull(point.start, ctx.epoch),
    time_unix_nano: absolute(point.time, ctx.epoch),
    attributes: attributesToJson(point.attributes),
    series_id: norm.seriesId,
    ...resourceAndScope(resource, scope),
    service_name: serviceName(resource),
    quantiles: pointField(point.point, 'quantileValues'),
    exemplars: pointField(point.point, 'exemplars'),
    flags: point.flags,
    delta_value: norm.deltaValue,
    delta_count: norm.deltaCount === null ? null : BigInt(norm.deltaCount),
    reset: norm.reset,
    out_of_order: norm.outOfOrder,
  };
}
