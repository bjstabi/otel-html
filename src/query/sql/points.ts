import { and, column, type ExprNode, eq, isIn, literal, Query, sql, verbatim } from '@uwdata/mosaic-sql';
import { OtelHtmlError } from '../../model/errors.js';
import { parseCondition } from '../../ottl/parse.js';
import { canonical, compileBy } from '../metric-paths.js';
import { jsonAt, PATH_COLUMNS } from './columns.js';
import { filenameTerm } from './filter.js';
import type { AbsWindow, Pruned } from './prune.js';
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

const SERIES_COLUMNS = [
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

/** The distinct series identities: the definition, the attributes, the resource and scope columns and the bounds. */
export function metricIdentitiesQuery(): Query {
  return Query.from('points')
    .distinct()
    .select(Object.fromEntries(SERIES_COLUMNS.map((c) => [c, sql`${verbatim(c)}`])));
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

/** A `by` path as the SQL expression of its JSON text: `src` as written, `identity` when it reads attributes, resource or scope. */
export interface ByExpr {
  src: string;
  expr: ExprNode;
  identity: boolean;
}

const invalidBy = (src: string, actual?: string): OtelHtmlError =>
  new OtelHtmlError('invalid-ottl', {
    path: `by ${JSON.stringify(src)}`,
    expected: 'a datapoint path with a column',
    ...(actual === undefined ? {} : { actual }),
  });

/**
 * The expression over `points` for a `by` path, as JSON text (D23): int `1` is `1` and string `"1"` is `"\"1\""`, so
 * the two stay apart. An attribute path goes through `jsonAt`, a scalar column through `to_json`.
 */
export function byExpr(path: string): ByExpr {
  const by = compileBy(path);
  const e = parseCondition(path);
  const v = e.type === 'value' && e.value.type === 'path' ? e.value : null;
  if (v === null) throw invalidBy(path);
  const canon = canonical(v).join('.');
  const col = PATH_COLUMNS.datapoint.get(canon);
  if (col === undefined) throw invalidBy(path, canon);
  if (col.kind === 'json')
    return { src: path, identity: by.identity, expr: sql`CAST(${jsonAt(col.column, by.keys)} AS VARCHAR)` };
  if (by.keys.length > 0) throw invalidBy(path, canon);
  return { src: path, identity: by.identity, expr: sql`to_json(${column(col.column)})` };
}

export interface SeriesOptions {
  identity: MetricIdentity;
  files: Pruned;
  where: ExprNode | null;
  resourceTexts: readonly string[] | null;
  seriesIds: Query | null;
  by: readonly ByExpr[];
}

/** The distinct series of one definition: `series_id`, the series columns and `g0..gN` (the `by` values) (D22). */
export function seriesQuery(opts: SeriesOptions): Query {
  const terms: ExprNode[] = [...identityTerms(opts.identity)];
  const files = filenameTerm(opts.files);
  if (files !== null) terms.push(files);
  if (opts.where !== null) terms.push(opts.where);
  if (opts.resourceTexts !== null)
    terms.push(
      opts.resourceTexts.length === 0
        ? literal(false)
        : isIn(
            column('resource_attributes'),
            opts.resourceTexts.map((t) => literal(t)),
          ),
    );
  if (opts.seriesIds !== null) terms.push(sql`series_id IN (${opts.seriesIds})`);
  return Query.from('points')
    .distinct()
    .select({
      series_id: sql`series_id`,
      ...Object.fromEntries(SERIES_COLUMNS.map((c) => [c, sql`${verbatim(c)}`])),
      ...Object.fromEntries(opts.by.map((b, i) => [`g${i}`, b.expr])),
    })
    .where(and(...terms));
}

/** Gaps per sampled series, and series sampled: D24's interval estimate. */
const INTERVAL_SERIES = 64;
const INTERVAL_GAPS = 32;

/** Rows `gap` (BIGINT): the first 32 gaps between consecutive points of each of at most 64 series (sampled by `hash(series_id)`) in the window. */
export function pointIntervalQuery(series: Query, files: Pruned, window: AbsWindow | null): Query {
  const sampled = Query.from({ s: series })
    .select({ series_id: sql`series_id` })
    .groupby(sql`series_id`)
    .orderby(sql`hash(series_id)`)
    .limit(INTERVAL_SERIES);
  const terms: ExprNode[] = [sql`series_id IN (${sampled})`];
  const f = filenameTerm(files);
  if (f !== null) terms.push(f);
  if (window !== null)
    terms.push(
      sql`time_unix_nano BETWEEN ${verbatim(`${window.start}::BIGINT`)} AND ${verbatim(`${window.end}::BIGINT`)}`,
    );
  const gaps = Query.from('points')
    .select({
      series_id: sql`series_id`,
      gap: sql`CAST(time_unix_nano - lag(time_unix_nano) OVER (PARTITION BY series_id ORDER BY time_unix_nano) AS BIGINT)`,
      rn: sql`row_number() OVER (PARTITION BY series_id ORDER BY time_unix_nano)`,
    })
    .where(and(...terms));
  return (
    Query.from({ t: gaps })
      .select({ gap: sql`gap` })
      // The first 32 gaps are rows 2..33: row 1 has no previous point.
      .where(sql`gap IS NOT NULL AND rn <= ${verbatim(String(INTERVAL_GAPS + 1))}`)
  );
}
