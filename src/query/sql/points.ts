import { and, type ExprNode, eq, literal, Query, sql, verbatim } from '@uwdata/mosaic-sql';
import { type BucketSpec, bucketExpr } from './time.js';

/** The columns that identify a metric definition. */
const IDENTITY_COLUMNS = [
  'metric_name',
  'point_type',
  'metric_unit',
  'aggregation_temporality',
  'is_monotonic',
] as const;

/** A metric definition as `points` stores it: `point_type` as `pointRow` writes it, the temporality as OTLP's number. */
export interface MetricIdentity {
  name: string;
  type: string;
  unit: string | null;
  temporality: number | null;
  monotonic: boolean | null;
}

const identitySelect = (): Record<string, ExprNode> =>
  Object.fromEntries(IDENTITY_COLUMNS.map((c) => [c, sql`${verbatim(c)}`]));

/** The terms selecting one definition's points: equality for the name and type, IS NOT DISTINCT FROM for the nullable columns. */
export function identityTerms(id: MetricIdentity): ExprNode[] {
  const same = (col: string, v: string | number | boolean | null): ExprNode =>
    sql`${verbatim(col)} IS NOT DISTINCT FROM ${v === null ? verbatim('NULL') : literal(v)}`;
  return [
    eq(sql`${verbatim('metric_name')}`, literal(id.name)),
    eq(sql`${verbatim('point_type')}`, literal(id.type)),
    same('metric_unit', id.unit),
    same('aggregation_temporality', id.temporality),
    same('is_monotonic', id.monotonic),
  ];
}

/** One row per definition with its point, series (distinct across partitions), reset, out-of-order and no-value counts and its scopes. */
export function metricDefsQuery(): Query {
  return Query.from('points')
    .select({
      ...identitySelect(),
      description: sql`min(metric_description)`,
      points: sql`count(*)`,
      series: sql`count(DISTINCT series_id)`,
      resets: sql`count(*) FILTER (WHERE reset)`,
      out_of_order: sql`count(*) FILTER (WHERE out_of_order)`,
      no_value: sql`count(*) FILTER (WHERE point_type IN ('gauge', 'sum') AND value_double IS NULL)`,
      scopes: sql`list(DISTINCT scope_name ORDER BY scope_name)`,
    })
    .groupby(...IDENTITY_COLUMNS.map((c) => sql`${verbatim(c)}`))
    .orderby(...IDENTITY_COLUMNS.map((c) => sql`${verbatim(c)}`));
}

/** The distinct series identities: the definition, the attributes, the resource and scope columns and the bounds. */
export function metricIdentitiesQuery(): Query {
  const cols = [
    ...IDENTITY_COLUMNS,
    'attributes',
    'resource_attributes',
    'resource_schema_url',
    'resource_dropped_attributes_count',
    'scope_name',
    'scope_version',
    'scope_attributes',
    'scope_schema_url',
    'scope_dropped_attributes_count',
    'explicit_bounds',
  ];
  return Query.from('points')
    .distinct()
    .select(Object.fromEntries(cols.map((c) => [c, sql`${verbatim(c)}`])));
}

/** The sparkline's bucket count: 128 buckets. */
export const SPARK_BUCKETS = 128;

const NATURAL_VALUE = `CASE point_type
  WHEN 'sum' THEN CASE WHEN is_monotonic THEN delta_value ELSE value_double END
  WHEN 'gauge' THEN value_double
  WHEN 'summary' THEN count
  ELSE delta_count END`;

/** Per definition and `bucket`: `sum` of the natural value of its points and `n`, the points that have one. */
export function metricSparkQuery(spec: BucketSpec, epoch: bigint): Query {
  return Query.from('points')
    .select({
      ...identitySelect(),
      bucket: bucketExpr('time_unix_nano', spec, epoch),
      sum: sql`sum(${verbatim(NATURAL_VALUE)})`,
      n: sql`count(${verbatim(NATURAL_VALUE)})`,
    })
    .groupby(...IDENTITY_COLUMNS.map((c) => sql`${verbatim(c)}`), sql`bucket`)
    .orderby(...IDENTITY_COLUMNS.map((c) => sql`${verbatim(c)}`), sql`bucket`);
}

/** The distinct `q` (DOUBLE) values of the definition's `quantiles` JSON, ascending (a whole-numbered quantile is stored as `{"$d": "1"}`). */
export function summaryQuantilesQuery(identity: MetricIdentity): Query {
  const entries = Query.from('points')
    .select({ e: sql`unnest(from_json(quantiles, '["JSON"]'))` })
    .where(and(...identityTerms(identity), sql`quantiles IS NOT NULL`));
  return Query.from({ t: entries })
    .distinct()
    .select({
      q: sql`CAST(coalesce(json_extract_string(e, '$.quantile."$d"'), json_extract_string(e, '$.quantile')) AS DOUBLE)`,
    })
    .orderby(sql`q`);
}
