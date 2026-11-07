import type { Attributes } from '../../model/anyvalue.js';
import { OtelHtmlError } from '../../model/errors.js';
import { type RelNanos, type SpanId, type TraceId, toRelNanos, type UnixNanos } from '../../model/ids.js';
import type {
  LogRecordRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
  SpanEventRecord,
  SpanLinkRecord,
  SpanRecord,
} from '../../model/records.js';
import { anyValueFromJson, attributesFromJson, attributesToJson } from '../columns.js';

/** A row as the query result delivers it: column name → value (bigint for int64, string for json). */
export type ResultRow = Readonly<Record<string, unknown>>;

export interface DecodedShared {
  resource: ResourceRecord;
  scope: ScopeRecord;
}

const bad = (path: string, expected: string, actual: unknown): OtelHtmlError =>
  new OtelHtmlError('invalid-report', {
    path,
    expected,
    actual: typeof actual === 'bigint' ? actual.toString() : (JSON.stringify(actual) ?? String(actual)),
  });

function str(row: ResultRow, col: string): string {
  const v = row[col];
  if (typeof v !== 'string') throw bad(col, 'a string', v);
  return v;
}

function strOrNull(row: ResultRow, col: string): string | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw bad(col, 'a string or null', v);
  return v;
}

/** An int column: int64 arrives as bigint, int32 as number. Must fit a safe integer (counts, flags). */
function int(row: ResultRow, col: string): number {
  const v = row[col];
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'bigint' && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(v);
  }
  throw bad(col, 'a safe integer', v);
}

function unixNanos(v: unknown, col: string): UnixNanos {
  if (typeof v === 'bigint') return v as UnixNanos;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v) as UnixNanos;
  throw bad(col, 'an int64 time', v);
}

function rel(row: ResultRow, col: string, epoch: bigint): RelNanos {
  return toRelNanos(unixNanos(row[col], col), epoch as UnixNanos, col);
}

function relOrNull(row: ResultRow, col: string, epoch: bigint): RelNanos | null {
  return row[col] === null || row[col] === undefined ? null : rel(row, col, epoch);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A property of a parsed JSON object (index-signature access, kept out of dot syntax for the type checker). */
function get(o: Record<string, unknown>, key: string): unknown {
  return o[key];
}

function jsonList(text: string, col: string): Record<string, unknown>[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw bad(col, 'JSON text', text);
  }
  if (!Array.isArray(v)) throw bad(col, 'an array', v);
  return v.map((x, i) => {
    if (!isObject(x)) throw bad(`${col}[${i}]`, 'an object', x);
    return x;
  });
}

function jsonStr(o: Record<string, unknown>, key: string, path: string): string {
  const v = get(o, key);
  if (typeof v !== 'string') throw bad(`${path}.${key}`, 'a string', v);
  return v;
}

function jsonInt(o: Record<string, unknown>, key: string, path: string): number {
  const v = get(o, key);
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw bad(`${path}.${key}`, 'a safe integer', v);
  return v;
}

function jsonAttrs(o: Record<string, unknown>, path: string): Attributes {
  const v = get(o, 'attributes');
  if (!isObject(v)) throw bad(`${path}.attributes`, 'an attribute object', v);
  return attributesFromJson(JSON.stringify(v));
}

/** An int64 in the events JSON: a plain number, or `{"$i": "<decimal>"}` beyond 2^53. */
function jsonTime(o: Record<string, unknown>, key: string, path: string): UnixNanos {
  const v = get(o, key);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v) as UnixNanos;
  const tagged = isObject(v) ? get(v, '$i') : undefined;
  if (typeof tagged === 'string' && /^-?[0-9]+$/.test(tagged)) return BigInt(tagged) as UnixNanos;
  throw bad(`${path}.${key}`, 'an int64', v);
}

function events(text: string, epoch: bigint): SpanEventRecord[] {
  return jsonList(text, 'events').map((e, i) => {
    const path = `events[${i}]`;
    return {
      time: toRelNanos(jsonTime(e, 'time_unix_nano', path), epoch as UnixNanos, `${path}.time_unix_nano`),
      name: jsonStr(e, 'name', path),
      attributes: jsonAttrs(e, path),
      droppedAttributesCount: jsonInt(e, 'dropped_attributes_count', path),
    };
  });
}

function links(text: string): SpanLinkRecord[] {
  return jsonList(text, 'links').map((l, i) => {
    const path = `links[${i}]`;
    return {
      traceId: jsonStr(l, 'trace_id', path) as TraceId,
      spanId: jsonStr(l, 'span_id', path) as SpanId,
      traceState: jsonStr(l, 'trace_state', path),
      attributes: jsonAttrs(l, path),
      droppedAttributesCount: jsonInt(l, 'dropped_attributes_count', path),
      flags: jsonInt(l, 'flags', path),
    };
  });
}

function shared(row: ResultRow): DecodedShared {
  return {
    resource: {
      attributes: attributesFromJson(str(row, 'resource_attributes')),
      droppedAttributesCount: int(row, 'resource_dropped_attributes_count'),
      schemaUrl: str(row, 'resource_schema_url'),
    },
    scope: {
      name: str(row, 'scope_name'),
      version: str(row, 'scope_version'),
      attributes: attributesFromJson(str(row, 'scope_attributes')),
      droppedAttributesCount: int(row, 'scope_dropped_attributes_count'),
      schemaUrl: str(row, 'scope_schema_url'),
    },
  };
}

const PLACEHOLDER_RESOURCE = 0 as ResourceRef;
const PLACEHOLDER_SCOPE = 0 as ScopeRef;

/**
 * The inverse of `spanRow`: times relative to `epoch`, attributes/events/links from their JSON texts. `resource`/`scope`
 * refs are 0 placeholders for the caller's interner. Lossy by design: `duration_ns` is derived (clamped at 0) and
 * ignored, the record has start/end; uint32 fields come back from int64 columns (R29).
 */
export function spanFromRow(row: ResultRow, epoch: bigint): { span: SpanRecord; shared: DecodedShared } {
  const parent = strOrNull(row, 'parent_span_id');
  const span: SpanRecord = {
    traceId: str(row, 'trace_id') as TraceId,
    spanId: str(row, 'span_id') as SpanId,
    parentSpanId: parent === null ? null : (parent as SpanId),
    traceState: str(row, 'trace_state'),
    flags: int(row, 'flags'),
    name: str(row, 'name'),
    kind: int(row, 'kind') as SpanRecord['kind'],
    start: rel(row, 'start_time_unix_nano', epoch),
    end: rel(row, 'end_time_unix_nano', epoch),
    attributes: attributesFromJson(str(row, 'attributes')),
    droppedAttributesCount: int(row, 'dropped_attributes_count'),
    events: events(str(row, 'events'), epoch),
    droppedEventsCount: int(row, 'dropped_events_count'),
    links: links(str(row, 'links')),
    droppedLinksCount: int(row, 'dropped_links_count'),
    status: {
      code: int(row, 'status_code') as SpanRecord['status']['code'],
      message: str(row, 'status_message'),
    },
    resource: PLACEHOLDER_RESOURCE,
    scope: PLACEHOLDER_SCOPE,
  };
  return { span, shared: shared(row) };
}

/** The inverse of `logRow`; a null `event_name` (R9) decodes to the empty string. */
export function logFromRow(row: ResultRow, epoch: bigint): { log: LogRecordRecord; shared: DecodedShared } {
  const log: LogRecordRecord = {
    time: relOrNull(row, 'time_unix_nano', epoch),
    observedTime: relOrNull(row, 'observed_time_unix_nano', epoch),
    severityNumber: int(row, 'severity_number'),
    severityText: str(row, 'severity_text'),
    body: anyValueFromJson(str(row, 'body')),
    attributes: attributesFromJson(str(row, 'attributes')),
    droppedAttributesCount: int(row, 'dropped_attributes_count'),
    flags: int(row, 'flags'),
    traceId: strOrNull(row, 'trace_id') as TraceId | null,
    spanId: strOrNull(row, 'span_id') as SpanId | null,
    eventName: strOrNull(row, 'event_name') ?? '',
    resource: PLACEHOLDER_RESOURCE,
    scope: PLACEHOLDER_SCOPE,
  };
  return { log, shared: shared(row) };
}

/** Interns resources and scopes by their JSON text + schema_url + dropped count, handing out stable refs within one result. */
export class SharedInterner {
  readonly #resources: ResourceRecord[] = [];
  readonly #scopes: ScopeRecord[] = [];
  readonly #resourceKeys = new Map<string, ResourceRef>();
  readonly #scopeKeys = new Map<string, ScopeRef>();

  get resources(): readonly ResourceRecord[] {
    return this.#resources;
  }

  get scopes(): readonly ScopeRecord[] {
    return this.#scopes;
  }

  resource(r: ResourceRecord): ResourceRef {
    const key = JSON.stringify([attributesToJson(r.attributes), r.schemaUrl, r.droppedAttributesCount]);
    let ref = this.#resourceKeys.get(key);
    if (ref === undefined) {
      ref = this.#resources.length as ResourceRef;
      this.#resources.push(r);
      this.#resourceKeys.set(key, ref);
    }
    return ref;
  }

  scope(s: ScopeRecord): ScopeRef {
    const key = JSON.stringify([
      s.name,
      s.version,
      attributesToJson(s.attributes),
      s.schemaUrl,
      s.droppedAttributesCount,
    ]);
    let ref = this.#scopeKeys.get(key);
    if (ref === undefined) {
      ref = this.#scopes.length as ScopeRef;
      this.#scopes.push(s);
      this.#scopeKeys.set(key, ref);
    }
    return ref;
  }
}
