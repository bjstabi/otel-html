import type { AnyValue, Attributes } from '../model/anyvalue.js';
import { OtelHtmlError } from '../model/errors.js';
import { type RelNanos, toUnixNanos, type UnixNanos } from '../model/ids.js';
import type {
  LogRecordRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
  SpanEventRecord,
  SpanLinkRecord,
  SpanRecord,
} from '../model/records.js';
import type { JsonValue } from './columns.js';
import { bytesToBase64 } from './data-file.js';

function anyValueJson(v: AnyValue): JsonValue {
  switch (v.kind) {
    case 'string':
      return { stringValue: v.value };
    case 'bool':
      return { boolValue: v.value };
    case 'int':
      return { intValue: v.value.toString() };
    case 'double':
      // OTLP JSON spells non-finite doubles as strings.
      return {
        doubleValue:
          Number.isFinite(v.value) && !Object.is(v.value, -0)
            ? v.value
            : String(Object.is(v.value, -0) ? '-0' : v.value),
      };
    case 'bytes':
      return { bytesValue: bytesToBase64(v.value) };
    case 'array':
      return { arrayValue: { values: v.values.map(anyValueJson) } };
    case 'kvlist':
      return { kvlistValue: { values: keyValues(v.values) } };
    case 'empty':
      return {};
  }
}

function keyValues(a: Attributes): JsonValue[] {
  return [...a].map(([key, value]) => ({ key, value: anyValueJson(value) }));
}

function nanos(t: number, epoch: UnixNanos, path: string): string {
  const abs = toUnixNanos(t as RelNanos, epoch);
  if (abs < 0n) {
    throw new OtelHtmlError('time-out-of-range', {
      path,
      expected: 'a non-negative unix time',
      actual: `${abs} ns`,
    });
  }
  return abs.toString();
}

function eventJson(e: SpanEventRecord, epoch: UnixNanos, path: string): JsonValue {
  return {
    timeUnixNano: nanos(e.time, epoch, `${path}.time`),
    name: e.name,
    attributes: keyValues(e.attributes),
    droppedAttributesCount: e.droppedAttributesCount,
  };
}

function linkJson(l: SpanLinkRecord): JsonValue {
  return {
    traceId: l.traceId,
    spanId: l.spanId,
    traceState: l.traceState,
    attributes: keyValues(l.attributes),
    droppedAttributesCount: l.droppedAttributesCount,
    flags: l.flags,
  };
}

function spanJson(s: SpanRecord, epoch: UnixNanos, path: string): JsonValue {
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    traceState: s.traceState,
    flags: s.flags,
    name: s.name,
    kind: s.kind,
    startTimeUnixNano: nanos(s.start, epoch, `${path}.start`),
    endTimeUnixNano: nanos(s.end, epoch, `${path}.end`),
    attributes: keyValues(s.attributes),
    droppedAttributesCount: s.droppedAttributesCount,
    events: s.events.map((e, i) => eventJson(e, epoch, `${path}.events[${i}]`)),
    droppedEventsCount: s.droppedEventsCount,
    links: s.links.map(linkJson),
    droppedLinksCount: s.droppedLinksCount,
    status: { code: s.status.code, message: s.status.message },
    ...(s.parentSpanId === null ? {} : { parentSpanId: s.parentSpanId }),
  };
}

/** Valid OTLP JSON (`ExportTraceServiceRequest`) for `spans`, grouped by resource then scope. */
export function spansToOtlpJson(
  spans: readonly SpanRecord[],
  resources: (r: ResourceRef) => ResourceRecord,
  scopes: (s: ScopeRef) => ScopeRecord,
  epoch: UnixNanos,
): unknown {
  const byResource = new Map<ResourceRef, Map<ScopeRef, JsonValue[]>>();
  for (const [i, s] of spans.entries()) {
    let byScope = byResource.get(s.resource);
    if (byScope === undefined) {
      byScope = new Map();
      byResource.set(s.resource, byScope);
    }
    let list = byScope.get(s.scope);
    if (list === undefined) {
      list = [];
      byScope.set(s.scope, list);
    }
    list.push(spanJson(s, epoch, `spans[${i}]`));
  }
  const resourceSpans: JsonValue[] = [];
  for (const [ref, byScope] of byResource) {
    const r = resources(ref);
    const scopeSpans: JsonValue[] = [];
    for (const [sref, list] of byScope) {
      const sc = scopes(sref);
      scopeSpans.push({
        scope: scopeJson(sc),
        spans: list,
        schemaUrl: sc.schemaUrl,
      });
    }
    resourceSpans.push({
      resource: resourceJson(r),
      scopeSpans,
      schemaUrl: r.schemaUrl,
    });
  }
  return { resourceSpans };
}

function resourceJson(r: ResourceRecord): JsonValue {
  return { attributes: keyValues(r.attributes), droppedAttributesCount: r.droppedAttributesCount };
}

function scopeJson(sc: ScopeRecord): JsonValue {
  return {
    name: sc.name,
    version: sc.version,
    attributes: keyValues(sc.attributes),
    droppedAttributesCount: sc.droppedAttributesCount,
  };
}

/** An unset time is OTLP's 0. */
function nanosOrZero(t: RelNanos | null, epoch: UnixNanos, path: string): string {
  return t === null ? '0' : nanos(t, epoch, path);
}

function logJson(l: LogRecordRecord, epoch: UnixNanos, path: string): JsonValue {
  return {
    timeUnixNano: nanosOrZero(l.time, epoch, `${path}.time`),
    observedTimeUnixNano: nanosOrZero(l.observedTime, epoch, `${path}.observedTime`),
    severityNumber: l.severityNumber,
    severityText: l.severityText,
    ...(l.body.kind === 'empty' ? {} : { body: anyValueJson(l.body) }),
    attributes: keyValues(l.attributes),
    droppedAttributesCount: l.droppedAttributesCount,
    flags: l.flags,
    ...(l.traceId === null ? {} : { traceId: l.traceId }),
    ...(l.spanId === null ? {} : { spanId: l.spanId }),
    eventName: l.eventName,
  };
}

/** A log with the resource and scope records it belongs to (a `LogRow`, for example). */
export interface OtlpLogInput {
  readonly log: LogRecordRecord;
  readonly resource: ResourceRecord;
  readonly scope: ScopeRecord;
}

/**
 * Valid OTLP JSON (`ExportLogsServiceRequest`) for `rows`, grouped by resource then scope. Rows are grouped by
 * record object identity: one decoded chunk shares its resource and scope objects across its logs.
 */
export function logsToOtlpJson(rows: readonly OtlpLogInput[], epoch: UnixNanos): unknown {
  const byResource = new Map<ResourceRecord, Map<ScopeRecord, JsonValue[]>>();
  for (const [i, r] of rows.entries()) {
    let byScope = byResource.get(r.resource);
    if (byScope === undefined) {
      byScope = new Map();
      byResource.set(r.resource, byScope);
    }
    let list = byScope.get(r.scope);
    if (list === undefined) {
      list = [];
      byScope.set(r.scope, list);
    }
    list.push(logJson(r.log, epoch, `logs[${i}]`));
  }
  const resourceLogs: JsonValue[] = [];
  for (const [resource, byScope] of byResource) {
    const scopeLogs: JsonValue[] = [];
    for (const [scope, logRecords] of byScope) {
      scopeLogs.push({ scope: scopeJson(scope), logRecords, schemaUrl: scope.schemaUrl });
    }
    resourceLogs.push({ resource: resourceJson(resource), scopeLogs, schemaUrl: resource.schemaUrl });
  }
  return { resourceLogs };
}
