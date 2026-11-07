import { column, type ExprNode, literal, Query, sql, verbatim } from '@uwdata/mosaic-sql';
import { anyValueToDisplay } from '../../model/anyvalue.js';
import { SpanKind, StatusCode } from '../../model/records.js';
import type { LogTarget, SpanTarget } from '../../ottl/contexts.js';
import { MAX_FACET_VALUE_LENGTH } from '../../rollups/facet-values.js';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_HOST_NAME,
  ATTR_SERVICE_NAME,
} from '../../semconv/attributes.js';
import { resourceName, serviceName } from '../../semconv/resource-name.js';
import { LOG_SEVERITY_KEYS, SEVERITY_BANDS, severityKey } from '../../semconv/severity.js';
import { bindOnce, jsonKind, jsonStringAt } from './columns.js';
import { type SqlFilter, whereOf } from './filter.js';

/** The caps a filtered set's facets are limited with (structurally the viewer's `FacetCaps`). */
export interface FacetCaps {
  readonly facetValueCap: number;
  readonly facetKeyCap: number;
}

export interface CoreFacet {
  readonly key: string;
  readonly label: string;
  readonly scope: 'core' | 'resource';
  /** The VARCHAR expression of the facet's value, null when the row has none. */
  readonly expr: ExprNode;
  readonly kind: 'string' | 'int' | 'double' | 'bool';
}

/** A default facet as the chunk writer's rollups read it: key, label and the value of one record. */
export interface DefaultSpanFacet {
  readonly key: string;
  readonly label: string;
  readonly scope: 'core' | 'resource';
  readonly value: (t: SpanTarget) => string | undefined;
}
export interface DefaultLogFacet {
  readonly key: string;
  readonly label: string;
  /** Where the key lives in the data: a resource attribute, or a core log field. */
  readonly scope: 'core' | 'resource';
  /** `undefined` leaves the log out of this facet. */
  readonly value: (t: LogTarget) => string | undefined;
}

function spanKindName(k: SpanKind): string {
  switch (k) {
    case SpanKind.UNSPECIFIED:
      return 'unspecified';
    case SpanKind.INTERNAL:
      return 'internal';
    case SpanKind.SERVER:
      return 'server';
    case SpanKind.CLIENT:
      return 'client';
    case SpanKind.PRODUCER:
      return 'producer';
    case SpanKind.CONSUMER:
      return 'consumer';
  }
}

/** `ok` | `error` | `unset` of a status code. */
export function statusKey(c: StatusCode): 'ok' | 'error' | 'unset' {
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
  { key: ATTR_SERVICE_NAME, label: 'Service', scope: 'resource', value: (t) => serviceName(t.resource) },
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

/** Default facets whose values are resource attributes (span attributes of these names are not faceted). */
export const SPAN_RESOURCE_FACET_KEYS: ReadonlySet<string> = new Set([
  ATTR_SERVICE_NAME,
  ATTR_HOST_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
]);
/** Default facets whose values are resource attributes (log attributes of these names are not faceted). */
export const LOG_RESOURCE_FACET_KEYS: ReadonlySet<string> = new Set([ATTR_SERVICE_NAME, ATTR_HOST_NAME]);

const col = (name: string): ExprNode => column(name);
const KIND_NAMES = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];
const kindCase = sql`CASE coalesce(${col('kind')}, 0) ${verbatim(
  KIND_NAMES.map((n, i) => `WHEN ${i} THEN '${n}'`).join(' '),
)} END`;
const statusCase = sql`CASE coalesce(${col('status_code')}, 0) WHEN 1 THEN 'ok' WHEN 2 THEN 'error' ELSE 'unset' END`;
const severityCase = sql`CASE ${verbatim(
  LOG_SEVERITY_KEYS.map(
    (k) =>
      `WHEN ${SEVERITY_BANDS[k].min} <= coalesce(severity_number, 0) AND coalesce(severity_number, 0) <= ${SEVERITY_BANDS[k].max} THEN '${k}'`,
  ).join(' '),
)} END`;

const SPAN_EXPRS: Readonly<Record<string, ExprNode>> = {
  [ATTR_SERVICE_NAME]: col('service_name'),
  'span.name': col('name'),
  'span.kind': kindCase,
  'status.code': statusCase,
  resource: col('resource_name'),
  'instrumentation_scope.name': col('scope_name'),
  [ATTR_HOST_NAME]: jsonStringAt('resource_attributes', [ATTR_HOST_NAME]),
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: jsonStringAt('resource_attributes', [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]),
};
const LOG_EXPRS: Readonly<Record<string, ExprNode>> = {
  severity: severityCase,
  [ATTR_SERVICE_NAME]: col('service_name'),
  [ATTR_HOST_NAME]: col('host_name'),
  'instrumentation_scope.name': col('scope_name'),
  'event.name': sql`nullif(${col('event_name')}, '')`,
  'trace.present': sql`CASE WHEN ${col('trace_id')} IS NULL THEN 'no' ELSE 'yes' END`,
};

function coreOf(
  defaults: readonly { key: string; label: string; scope: 'core' | 'resource' }[],
  exprs: Readonly<Record<string, ExprNode>>,
): CoreFacet[] {
  return defaults.map((d) => ({
    key: d.key,
    label: d.label,
    scope: d.scope,
    expr: exprs[d.key] ?? literal(null),
    kind: 'string',
  }));
}

export const CORE_SPAN_FACETS: readonly CoreFacet[] = coreOf(DEFAULT_SPAN_FACETS, SPAN_EXPRS);
export const CORE_LOG_FACETS: readonly CoreFacet[] = coreOf(DEFAULT_LOG_FACETS, LOG_EXPRS);

const truncated = (e: ExprNode): ExprNode => sql`left(${e}, ${verbatim(String(MAX_FACET_VALUE_LENGTH))})`;

/**
 * One query: `GROUP BY GROUPING SETS ((f1), (f2), ...)` over the chosen core facets. Rows (key, value, n); a row with no
 * value for a facet is skipped. Values are cut to `MAX_FACET_VALUE_LENGTH`.
 */
export function coreFacetsQuery(f: SqlFilter, table: 'spans' | 'logs', keys: readonly CoreFacet[]): Query {
  const names = keys.map((_, i) => `f${i}`);
  const inner = Query.from(table)
    .select(Object.fromEntries(keys.map((k, i) => [names[i] as string, truncated(k.expr)])))
    .where(...whereOf(f, table));
  const which = sql`CASE ${verbatim(
    keys.map((k, i) => `WHEN grouping(f${i}) = 0 THEN ${literal(k.key)}`).join(' '),
  )} END`;
  const value = sql`coalesce(${verbatim(names.join(', '))})`;
  return Query.from({ s: inner })
    .select({ key: which, value, n: sql`count(*)` })
    .groupby(sql`GROUPING SETS (${verbatim(names.map((n) => `(${n})`).join(', '))})`)
    .having(sql`${value} IS NOT NULL`)
    .orderby(sql`key`, sql`n DESC`, sql`value`);
}

const SCALARS = verbatim(`('string', 'int', 'double', 'bool')`);

/**
 * The (key, value) entries of an attributes JSON text as a list of structs: a plain object through a MAP, the `$m`
 * pairs form through its pair list (a record that holds a `$`-prefixed key is stored that way, and
 * `json_keys` would only see "$m").
 */
const ENTRIES = bindOnce(
  sql`CAST(${column('attributes')} AS JSON)`,
  'a',
  (a) => sql`CASE
  WHEN json_exists(${a}, '/$m') THEN list_transform(from_json(json_extract(${a}, '/$m'), '["JSON"]'), (x) -> {'key': json_extract_string(x, '/0'), 'value': json_extract(x, '/1')})
  ELSE list_transform(json_keys(${a}), (k) -> {'key': k, 'value': json_extract(${a}, '/' || replace(replace(k, '~', '~0'), '/', '~1'))}) END`,
);

/**
 * Attribute facets in one query over `table`: every attribute key with a scalar value (a key in `excludeKeys` is left
 * out), value text and kind (`mixed` when a key holds more than one kind), `valueCap` values per key by count then
 * text, the `facetKeyCap` keys with the most occurrences. Rows (key, kind, value, n, total): `total` counts every
 * occurrence of the key, so `total - sum(n)` is what the value cap dropped.
 */
export function attributeFacetsQuery(
  f: SqlFilter,
  table: 'spans' | 'logs',
  caps: FacetCaps,
  excludeKeys: readonly string[],
): Query {
  const entries = Query.from(table)
    .select({ e: sql`unnest(${ENTRIES})` })
    .where(...whereOf(f, table), sql`attributes IS NOT NULL`);
  const flat = Query.from({ entries })
    .select({ k: sql`e.key`, v: sql`e.value` })
    .where(
      excludeKeys.length === 0
        ? sql`true`
        : sql`e.key NOT IN (${verbatim(excludeKeys.map((k) => literal(k).toString()).join(', '))})`,
    );
  const typed = Query.from({ flat }).select({
    k: col('k'),
    kind: jsonKind(col('v')),
    txt: truncated(
      bindOnce(
        col('v'),
        't',
        (t) =>
          sql`coalesce(json_extract_string(${t}, '/$i'), json_extract_string(${t}, '/$d'), json_extract_string(${t}, '$'))`,
      ),
    ),
  });
  const grouped = Query.from({ typed })
    .select({ k: col('k'), kind: col('kind'), txt: col('txt'), n: sql`count(*)` })
    .where(sql`kind IN ${SCALARS} AND txt IS NOT NULL`)
    .groupby(col('k'), col('kind'), col('txt'));
  const perKey = Query.from({ grouped })
    .select({
      key: col('k'),
      kind: sql`CASE WHEN min(kind) OVER (PARTITION BY k) = max(kind) OVER (PARTITION BY k) THEN kind ELSE 'mixed' END`,
      value: col('txt'),
      n: col('n'),
      total: sql`CAST(sum(n) OVER (PARTITION BY k) AS BIGINT)`,
    })
    .qualify(sql`row_number() OVER (PARTITION BY k ORDER BY n DESC, txt) <= ${literal(caps.facetValueCap)}`);
  return Query.from({ perKey })
    .select('key', 'kind', 'value', 'n', 'total')
    .qualify(sql`dense_rank() OVER (ORDER BY total DESC, key) <= ${literal(caps.facetKeyCap)}`)
    .orderby(sql`total DESC`, sql`key`, sql`n DESC`, sql`value`);
}
