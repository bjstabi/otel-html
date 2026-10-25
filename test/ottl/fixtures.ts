import type { AnyValue, Attributes } from '../../src/model/anyvalue.js';
import type { RelNanos, SpanId, TraceId, UnixNanos } from '../../src/model/ids.js';
import {
  type LogRecordRecord,
  type ResourceRecord,
  type ResourceRef,
  type ScopeRecord,
  type ScopeRef,
  SpanKind,
  type SpanRecord,
  StatusCode,
} from '../../src/model/records.js';
import type { LogTarget, SpanTarget } from '../../src/ottl/contexts.js';

function attrs(o: Record<string, AnyValue>): Attributes {
  return new Map(Object.entries(o));
}

const str = (value: string): AnyValue => ({ kind: 'string', value });
const int = (value: bigint): AnyValue => ({ kind: 'int', value });

const resource: ResourceRecord = {
  attributes: attrs({ 'service.name': str('checkout') }),
  droppedAttributesCount: 0,
  schemaUrl: '',
};
const scope: ScopeRecord = {
  name: 'my.lib',
  version: '1.2',
  attributes: attrs({}),
  droppedAttributesCount: 0,
  schemaUrl: '',
};
const epoch = 1_700_000_000_000_000_000n as UnixNanos;

export function spanTarget(over: Partial<SpanRecord> = {}): SpanTarget {
  const span: SpanRecord = {
    traceId: 'a'.repeat(32) as TraceId,
    spanId: 'b'.repeat(16) as SpanId,
    parentSpanId: 'c'.repeat(16) as SpanId,
    traceState: 'k=v',
    flags: 0,
    name: 'GET /api/cart',
    kind: SpanKind.SERVER,
    start: 1_000_000 as RelNanos,
    end: 301_000_000 as RelNanos,
    attributes: attrs({
      'http.route': str('/api/cart'),
      'http.response.status_code': int(503n),
      nested: { kind: 'kvlist', values: attrs({ a: str('deep') }) },
      list: { kind: 'array', values: [str('x'), int(2n)] },
    }),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: StatusCode.ERROR, message: 'upstream failed' },
    resource: 0 as ResourceRef,
    scope: 0 as ScopeRef,
    ...over,
  };
  return { span, resource, scope, epoch };
}

export function logTarget(over: Partial<LogRecordRecord> = {}): LogTarget {
  const log: LogRecordRecord = {
    time: 5 as RelNanos,
    observedTime: null,
    severityNumber: 17,
    severityText: 'ERROR',
    body: str('payment declined'),
    attributes: attrs({ code: int(42n) }),
    droppedAttributesCount: 0,
    flags: 0,
    traceId: null,
    spanId: null,
    eventName: '',
    resource: 0 as ResourceRef,
    scope: 0 as ScopeRef,
    ...over,
  };
  return { log, resource, scope, epoch };
}
