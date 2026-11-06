import { OtelHtmlError } from '../../model/errors.js';
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
import {
  anyValueJson,
  attributesToJson,
  attributesToJsonValue,
  doublesJson,
  type JsonValue,
} from '../columns.js';

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

const POINT_TYPE = {
  gauge: 'gauge',
  sum: 'sum',
  histogram: 'histogram',
  exponentialHistogram: 'exp_histogram',
  summary: 'summary',
} as const;

const TEMPORALITY_NUMBER = { unspecified: 0, delta: 1, cumulative: 2 } as const;

const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** An int64 in format-4 JSON: a plain number within +-(2^53-1), else `{"$i"}`. */
function intJson(n: bigint): JsonValue {
  return n <= SAFE_MAX && n >= -SAFE_MAX ? Number(n) : { $i: n.toString() };
}

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
    time_unix_nano: intJson(absolute(e.time, ctx.epoch)),
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

const bad = (path: string, expected: string, actual: unknown): OtelHtmlError =>
  new OtelHtmlError('invalid-report', { path, expected, actual: JSON.stringify(actual) ?? String(actual) });

/** The field of a point's JSON (protobuf JSON: int64 as decimal strings, non-finite doubles as strings), if present. */
function field(point: unknown, key: string): unknown {
  if (typeof point !== 'object' || point === null) return undefined;
  return Object.getOwnPropertyDescriptor(point, key)?.value;
}

function double(v: unknown, path: string): number | null {
  if (v === undefined) return null;
  if (typeof v === 'number') return v;
  if (v === 'NaN') return Number.NaN;
  if (v === 'Infinity') return Number.POSITIVE_INFINITY;
  if (v === '-Infinity') return Number.NEGATIVE_INFINITY;
  throw bad(path, 'a number or "NaN" | "Infinity" | "-Infinity"', v);
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * An int64 field: a decimal string (a missing one is the protobuf default, `absent`). A value outside the signed int64
 * range (a uint64 above 2^63-1) is rejected, not clamped.
 */
function int64(v: unknown, path: string, absent: bigint | null): bigint | null {
  if (v === undefined) return absent;
  if (typeof v === 'string' && /^-?[0-9]+$/.test(v)) {
    const n = BigInt(v);
    if (n >= INT64_MIN && n <= INT64_MAX) return n;
    throw bad(path, 'an integer within the signed int64 range', v);
  }
  throw bad(path, 'a decimal integer string', v);
}

function list<T>(v: unknown, path: string, item: (x: unknown, p: string) => T | null): T[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw bad(path, 'an array', v);
  return v.map((x, i) => {
    const r = item(x, `${path}[${i}]`);
    if (r === null) throw bad(`${path}[${i}]`, 'a value', x);
    return r;
  });
}

function int32(v: unknown, path: string, absent: number | null): number | null {
  if (v === undefined) return absent;
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  throw bad(path, 'an integer', v);
}

/** The kind-specific value columns of a point, from its protobuf-JSON `point` (absent fields at their zero value). */
function pointValues(point: MetricPointRecord): Row {
  const p = point.point;
  const at = (k: string): string => `point.${k}`;
  const get = (k: string): unknown => field(p, k);
  switch (point.type) {
    case 'gauge':
    case 'sum': {
      // An int point's value is an int64 string; the column is float64, so ints beyond 2^53 lose precision here.
      const asInt = int64(get('asInt'), at('asInt'), null);
      const value = asInt === null ? double(get('asDouble'), at('asDouble')) : Number(asInt);
      return { value_double: value };
    }
    case 'histogram':
      return {
        count: int64(get('count'), at('count'), 0n),
        sum: double(get('sum'), at('sum')),
        min: double(get('min'), at('min')),
        max: double(get('max'), at('max')),
        explicit_bounds: list(get('explicitBounds'), at('explicitBounds'), double),
        bucket_counts: list(get('bucketCounts'), at('bucketCounts'), (x, q) => int64(x, q, null)),
      };
    case 'exponentialHistogram': {
      const positive = get('positive');
      const negative = get('negative');
      const buckets = (b: unknown, k: string): Row =>
        b === undefined
          ? { [`${k}_offset`]: null, [`${k}_counts`]: null }
          : {
              [`${k}_offset`]: int32(field(b, 'offset'), at(`${k}.offset`), 0),
              [`${k}_counts`]: list(field(b, 'bucketCounts'), at(`${k}.bucketCounts`), (x, q) =>
                int64(x, q, null),
              ),
            };
      return {
        count: int64(get('count'), at('count'), 0n),
        sum: double(get('sum'), at('sum')),
        min: double(get('min'), at('min')),
        max: double(get('max'), at('max')),
        scale: int32(get('scale'), at('scale'), 0),
        zero_count: int64(get('zeroCount'), at('zeroCount'), 0n),
        zero_threshold: double(get('zeroThreshold'), at('zeroThreshold')) ?? 0,
        ...buckets(positive, 'positive'),
        ...buckets(negative, 'negative'),
      };
    }
    case 'summary':
      return {
        count: int64(get('count'), at('count'), 0n),
        sum: double(get('sum'), at('sum')) ?? 0,
      };
  }
}

/** A tagged-JSON column from a field of the point's JSON, null when the point has none. */
function pointJsonColumn(point: unknown, key: string): string | null {
  const v = field(point, key);
  return v === undefined ? null : doublesJson(v);
}

/**
 * A metric point's row: identity, time, attributes, resource and scope, the normalization columns, and the value
 * columns of the point's type (gauge/sum: `value_double`; histogram: count, sum, min, max, bounds, bucket counts;
 * exponential histogram: count, sum, min, max, scale, zero count, positive/negative offset and counts; summary: count,
 * sum, `quantiles`). `exemplars` and `quantiles` are the point's JSON with numbers tagged as doubles. Columns that do
 * not apply to the type are absent (null when written).
 */
export function pointRow(point: MetricPointRecord, norm: PointNormalization, ctx: Context): Row {
  const resource = ctx.resources(point.resource);
  const scope = ctx.scopes(point.scope);
  return {
    metric_name: point.name,
    metric_description: point.description,
    metric_unit: point.unit,
    point_type: POINT_TYPE[point.type],
    aggregation_temporality: TEMPORALITY_NUMBER[point.temporality],
    is_monotonic: point.monotonic,
    start_time_unix_nano: absoluteOrNull(point.start, ctx.epoch),
    time_unix_nano: absolute(point.time, ctx.epoch),
    attributes: attributesToJson(point.attributes),
    series_id: norm.seriesId,
    ...resourceAndScope(resource, scope),
    service_name: serviceName(resource),
    ...pointValues(point),
    quantiles: pointJsonColumn(point.point, 'quantileValues'),
    exemplars: pointJsonColumn(point.point, 'exemplars'),
    flags: point.flags,
    delta_value: norm.deltaValue,
    delta_count: norm.deltaCount === null ? null : BigInt(norm.deltaCount),
    reset: norm.reset,
    out_of_order: norm.outOfOrder,
  };
}
