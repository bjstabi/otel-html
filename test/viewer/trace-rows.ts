import type { Attributes } from '../../src/model/anyvalue.js';
import type { RelNanos, SpanId, TraceId } from '../../src/model/ids.js';
import {
  type ResourceRecord,
  type ResourceRef,
  type ScopeRecord,
  type ScopeRef,
  type SpanRecord,
  StatusCode,
} from '../../src/model/records.js';
import type { TraceDetail } from '../../src/viewer/data/data-source.js';
import type { SpanRow } from '../../src/viewer/data/span-query.js';
import { buildTraceTree } from '../../src/viewer/data/trace-tree.js';

export const TRACE_ID = 'a'.repeat(32) as TraceId;
export const spanIdOf = (n: number): SpanId => n.toString(16).padStart(16, '0') as SpanId;

export interface RowOptions {
  service?: string;
  name?: string;
  error?: boolean;
  exception?: boolean;
  attributes?: Attributes;
}

/** A span row for tests: ids derive from numbers, times are RelNanos. */
export function traceRow(
  n: number,
  parent: number | null,
  start: number,
  end: number,
  o: RowOptions = {},
): SpanRow {
  const span: SpanRecord = {
    traceId: TRACE_ID,
    spanId: spanIdOf(n),
    parentSpanId: parent === null ? null : spanIdOf(parent),
    traceState: '',
    flags: 0,
    name: o.name ?? `n${n}`,
    kind: 1,
    start: start as RelNanos,
    end: end as RelNanos,
    attributes: o.attributes ?? new Map(),
    droppedAttributesCount: 0,
    events:
      o.exception === true
        ? [
            {
              time: start as RelNanos,
              name: 'exception',
              attributes: new Map(),
              droppedAttributesCount: 0,
            },
          ]
        : [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: o.error === true ? StatusCode.ERROR : StatusCode.UNSET, message: '' },
    resource: 0 as ResourceRef,
    scope: 0 as ScopeRef,
  };
  return { span, service: o.service ?? 'svc', resource: '/r', durationNs: Math.max(0, end - start) };
}

const RESOURCE: ResourceRecord = { attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' };
const SCOPE: ScopeRecord = {
  name: 'scope',
  version: '',
  attributes: new Map(),
  droppedAttributesCount: 0,
  schemaUrl: '',
};

export const str = (value: string): { readonly kind: 'string'; readonly value: string } => ({
  kind: 'string',
  value,
});

export function detailOf(spans: readonly SpanRow[]): TraceDetail {
  return {
    traceId: TRACE_ID,
    spans,
    tree: buildTraceTree(spans),
    resources: () => RESOURCE,
    scopes: () => SCOPE,
    logCount: 0,
  };
}
