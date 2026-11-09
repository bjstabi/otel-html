import { anyValueToDisplay } from '../model/anyvalue.js';
import { type SpanKind, StatusCode } from '../model/records.js';
import type { LogTarget, SpanTarget } from '../ottl/contexts.js';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME, ATTR_HOST_NAME, ATTR_SERVICE_NAME } from './attributes.js';
import { resourceName, serviceName } from './resource-name.js';
import { severityKey } from './severity.js';

/** The always-tracked facets of spans and logs as plain data (no SQL): the chunk rollups and the SQL builders share them (D16). */

export type SpanFacetKey =
  | typeof ATTR_SERVICE_NAME
  | 'span.name'
  | 'span.kind'
  | 'status.code'
  | 'resource'
  | 'instrumentation_scope.name'
  | typeof ATTR_HOST_NAME
  | typeof ATTR_DEPLOYMENT_ENVIRONMENT_NAME;
export type LogFacetKey =
  | 'severity'
  | typeof ATTR_SERVICE_NAME
  | typeof ATTR_HOST_NAME
  | 'instrumentation_scope.name'
  | 'event.name'
  | 'trace.present';

export interface DefaultSpanFacet {
  readonly key: SpanFacetKey;
  readonly label: string;
  readonly scope: 'core' | 'resource';
  readonly value: (t: SpanTarget) => string | undefined;
}
export interface DefaultLogFacet {
  readonly key: LogFacetKey;
  readonly label: string;
  /** Where the key lives in the data: a resource attribute, or a core log field. */
  readonly scope: 'core' | 'resource';
  /** `undefined` leaves the log out of this facet. */
  readonly value: (t: LogTarget) => string | undefined;
}

/** Names of the span kinds by their number. */
export const SPAN_KIND_NAMES: readonly string[] = [
  'unspecified',
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
];

function spanKindName(k: SpanKind): string {
  return SPAN_KIND_NAMES[k] ?? SPAN_KIND_NAMES[0] ?? 'unspecified';
}

/** `ok` | `error` | `unset` of a status code. */
function statusKey(c: StatusCode): 'ok' | 'error' | 'unset' {
  switch (c) {
    case StatusCode.OK:
      return 'ok';
    case StatusCode.ERROR:
      return 'error';
    case StatusCode.UNSET:
      return 'unset';
  }
}

function resourceAttr(t: SpanTarget, key: string): string | undefined {
  const v = t.resource.attributes.get(key);
  return v === undefined ? undefined : anyValueToDisplay(v);
}

/** Always-tracked span facets (exempt from the key cap), in display order. */
export const DEFAULT_SPAN_FACETS: readonly DefaultSpanFacet[] = [
  // scope 'core' as in the log facets and facet-panel.tsx: the service is filtered as `service.name`, not `resource.attributes[...]`
  { key: ATTR_SERVICE_NAME, label: 'Service', scope: 'core', value: (t) => serviceName(t.resource) },
  { key: 'span.name', label: 'Span name', scope: 'core', value: (t) => t.span.name },
  { key: 'span.kind', label: 'Kind', scope: 'core', value: (t) => spanKindName(t.span.kind) },
  { key: 'status.code', label: 'Status', scope: 'core', value: (t) => statusKey(t.span.status.code) },
  { key: 'resource', label: 'Resource', scope: 'core', value: (t) => resourceName(t.span) },
  { key: 'instrumentation_scope.name', label: 'Scope', scope: 'core', value: (t) => t.scope.name },
  { key: ATTR_HOST_NAME, label: 'Host', scope: 'resource', value: (t) => resourceAttr(t, ATTR_HOST_NAME) },
  {
    key: ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
    label: 'Environment',
    scope: 'resource',
    value: (t) => resourceAttr(t, ATTR_DEPLOYMENT_ENVIRONMENT_NAME),
  },
];

/** Always-tracked log facets (exempt from the key cap), in display order. */
export const DEFAULT_LOG_FACETS: readonly DefaultLogFacet[] = [
  { key: 'severity', label: 'Severity', scope: 'core', value: (t) => severityKey(t.log.severityNumber) },
  { key: ATTR_SERVICE_NAME, label: 'Service', scope: 'core', value: (t) => serviceName(t.resource) },
  {
    key: ATTR_HOST_NAME,
    label: 'Host',
    scope: 'resource',
    value: (t) => {
      const v = t.resource.attributes.get(ATTR_HOST_NAME);
      return v === undefined ? undefined : anyValueToDisplay(v);
    },
  },
  { key: 'instrumentation_scope.name', label: 'Scope', scope: 'core', value: (t) => t.scope.name },
  {
    key: 'event.name',
    label: 'Event name',
    scope: 'core',
    value: (t) => (t.log.eventName === '' ? undefined : t.log.eventName),
  },
  {
    key: 'trace.present',
    label: 'Has trace',
    scope: 'core',
    value: (t) => (t.log.traceId === null ? 'no' : 'yes'),
  },
];
