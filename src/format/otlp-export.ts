import type { AnyValue, Attributes } from '../model/anyvalue.js';
import { OtelHtmlError } from '../model/errors.js';
import { type RelNanos, toUnixNanos, type UnixNanos } from '../model/ids.js';
import type {
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
        scope: {
          name: sc.name,
          version: sc.version,
          attributes: keyValues(sc.attributes),
          droppedAttributesCount: sc.droppedAttributesCount,
        },
        spans: list,
        schemaUrl: sc.schemaUrl,
      });
    }
    resourceSpans.push({
      resource: { attributes: keyValues(r.attributes), droppedAttributesCount: r.droppedAttributesCount },
      scopeSpans,
      schemaUrl: r.schemaUrl,
    });
  }
  return { resourceSpans };
}
