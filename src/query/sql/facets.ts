import { column, type ExprNode, literal, Query, sql, verbatim } from '@uwdata/mosaic-sql';
import { MAX_FACET_VALUE_LENGTH } from '../../rollups/facet-values.js';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_HOST_NAME,
  ATTR_SERVICE_NAME,
} from '../../semconv/attributes.js';
import {
  DEFAULT_LOG_FACETS,
  DEFAULT_SPAN_FACETS,
  type LogFacetKey,
  SPAN_KIND_NAMES,
  type SpanFacetKey,
} from '../../semconv/default-facets.js';
import { LOG_SEVERITY_KEYS, SEVERITY_BANDS } from '../../semconv/severity.js';
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
const col = (name: string): ExprNode => column(name);
const kindCase = sql`CASE coalesce(${col('kind')}, 0) ${verbatim(
  SPAN_KIND_NAMES.map((n, i) => `WHEN ${i} THEN '${n}'`).join(' '),
)} END`;
const statusCase = sql`CASE coalesce(${col('status_code')}, 0) WHEN 1 THEN 'ok' WHEN 2 THEN 'error' ELSE 'unset' END`;
const severityCase = sql`CASE ${verbatim(
  LOG_SEVERITY_KEYS.map(
    (k) =>
      `WHEN ${SEVERITY_BANDS[k].min} <= coalesce(severity_number, 0) AND coalesce(severity_number, 0) <= ${SEVERITY_BANDS[k].max} THEN '${k}'`,
  ).join(' '),
)} END`;

const SPAN_EXPRS: Readonly<Record<SpanFacetKey, ExprNode>> = {
  [ATTR_SERVICE_NAME]: col('service_name'),
  'span.name': col('name'),
  'span.kind': kindCase,
  'status.code': statusCase,
  resource: col('resource_name'),
  'instrumentation_scope.name': col('scope_name'),
  [ATTR_HOST_NAME]: jsonStringAt('resource_attributes', [ATTR_HOST_NAME]),
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: jsonStringAt('resource_attributes', [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]),
};
const LOG_EXPRS: Readonly<Record<LogFacetKey, ExprNode>> = {
  severity: severityCase,
  [ATTR_SERVICE_NAME]: col('service_name'),
  [ATTR_HOST_NAME]: col('host_name'),
  'instrumentation_scope.name': col('scope_name'),
  'event.name': sql`nullif(${col('event_name')}, '')`,
  'trace.present': sql`CASE WHEN ${col('trace_id')} IS NULL THEN 'no' ELSE 'yes' END`,
};

function coreOf<K extends string>(
  defaults: readonly { key: K; label: string; scope: 'core' | 'resource' }[],
  exprs: Readonly<Record<K, ExprNode>>,
): CoreFacet[] {
  return defaults.map((d) => ({
    key: d.key,
    label: d.label,
    scope: d.scope,
    expr: exprs[d.key],
    kind: 'string',
  }));
}

export const CORE_SPAN_FACETS: readonly CoreFacet[] = coreOf(DEFAULT_SPAN_FACETS, SPAN_EXPRS);
export const CORE_LOG_FACETS: readonly CoreFacet[] = coreOf(DEFAULT_LOG_FACETS, LOG_EXPRS);

export const truncated = (e: ExprNode): ExprNode =>
  sql`left(${e}, ${verbatim(String(MAX_FACET_VALUE_LENGTH))})`;

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
