import { and, column, type ExprNode, eq, isIn, literal, Query, sql, verbatim } from '@uwdata/mosaic-sql';
import { assertNever, OtelHtmlError } from '../../model/errors.js';
import { parseCondition } from '../../ottl/parse.js';
import { canonical, compileBy } from '../metric-paths.js';
import { jsonAt, PATH_COLUMNS, relTime } from './columns.js';
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

/** The distinct `q` (DOUBLE) values of the definition's `quantiles` JSON (in `files` when given), ascending (a whole-numbered quantile is stored as `{"$d": "1"}`). */
export function summaryQuantilesQuery(identity: MetricIdentity, files?: Pruned): Query {
  const entries = Query.from('points')
    .select({ e: sql`unnest(from_json(quantiles, '["JSON"]'))` })
    .where(
      and(
        ...identityTerms(identity),
        ...(files === undefined ? [] : [filenameTerm(files)].filter((t) => t !== null)),
        sql`quantiles IS NOT NULL`,
      ),
    );
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
 * the two stay apart. An attribute path goes through `jsonAt`, a scalar column through `to_json`. `metric.description`
 * is not part of `series_id`, so grouping by it takes one value per series (`any_value`).
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

/**
 * One row per `series_id` of one definition: the series columns (`any_value`, plus `metric_description`) and `g0..gN`
 * (the `by` values) (D22). Grouping by `series_id` rather than DISTINCT over the columns keeps one row when the same
 * series was written with its attribute keys in another order (the id hashes them sorted, the JSON text keeps insertion order).
 */
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
    .select({
      series_id: sql`series_id`,
      ...Object.fromEntries(
        [...SERIES_COLUMNS, 'metric_description'].map((c) => [c, sql`any_value(${verbatim(c)})`]),
      ),
      ...Object.fromEntries(opts.by.map((b, i) => [`g${i}`, sql`any_value(${b.expr})`])),
    })
    .where(and(...terms))
    .groupby(sql`series_id`);
}

/** Gaps per sampled series, and series sampled: D24's interval estimate. */
const INTERVAL_SERIES = 64;
const INTERVAL_GAPS = 32;

/** Rows `gap` (BIGINT): the first 32 gaps between consecutive points of each of at most 64 series (sampled by `hash(series_id)`) in the window. */
export function pointIntervalQuery(
  identity: MetricIdentity,
  series: Query,
  files: Pruned,
  window: AbsWindow | null,
): Query {
  const sampled = Query.from({ s: series })
    .select({ series_id: sql`series_id` })
    .groupby(sql`series_id`)
    .orderby(sql`hash(series_id)`)
    .limit(INTERVAL_SERIES);
  const terms: ExprNode[] = [sql`series_id IN (${sampled})`, ...identityTerms(identity)];
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

/** The five aggregate shapes of D25. */
export type MetricKind = 'counter' | 'number' | 'hist' | 'exp' | 'summary';

/**
 * Where a point lands: a time bucket, or the value of a run expression. `baseline` sends the points before the window to
 * cell -1 (the window's lower bound is dropped from the points filter). The caller must then prune `files` without the
 * window's lower bound too, for the series query and the cells query alike, or cell -1 misses the earlier partitions.
 */
export type Cell = { kind: 'time'; widthNs: number; baseline: boolean } | { kind: 'run'; run: ByExpr };

/** The cell of a point: `floor(rel / w) * w` (non-negative modulo, as `bucketExpr`), -1 before `window` for a baseline, else the run expression. */
export function cellExpr(cell: Cell, epoch: bigint, window: AbsWindow | null = null): ExprNode {
  if (cell.kind === 'run') return cell.run.expr;
  const w = verbatim(`${BigInt(Math.round(cell.widthNs))}::BIGINT`);
  const rel = relTime('time_unix_nano', epoch);
  const bucket = sql`(${rel} - ((${rel} % ${w}) + ${w}) % ${w})`;
  if (!cell.baseline || window === null) return bucket;
  return sql`CASE WHEN time_unix_nano < ${verbatim(`${window.start}::BIGINT`)} THEN -1 ELSE ${bucket} END`;
}

/** Across-series aggregate per `show` of a number metric (COMBINE.number.byShow of the viewer). */
// Exported as the parity hook for the viewer's COMBINE test.
export const NUMBER_SHOWS = {
  avg: { per: 'a', across: 'avg' },
  min: { per: 'mn', across: 'min' },
  max: { per: 'mx', across: 'max' },
  last: { per: 'lt', across: 'sum' },
} as const;
const numberShow = (show: string): { per: string; across: string } =>
  show === 'min' || show === 'max' || show === 'last' ? NUMBER_SHOWS[show] : NUMBER_SHOWS.avg;

const groupNames = (n: number): string[] => Array.from({ length: n }, (_, i) => `g${i}`);
const gRefs = (n: number): ExprNode[] => groupNames(n).map((g) => sql`${verbatim(g)}`);
const gSelect = (n: number): Record<string, ExprNode> =>
  Object.fromEntries(groupNames(n).map((g) => [g, sql`${verbatim(g)}`]));

export interface CellsOptions {
  /** The definition of `series`: its terms go on the points side so row-group statistics can skip data. */
  identity: MetricIdentity;
  kind: MetricKind;
  show: string;
  series: Query;
  files: Pruned;
  window: AbsWindow | null;
  cell: Cell;
  epoch: bigint;
  byCount: number;
}

const timeTerm = (window: AbsWindow | null, baseline: boolean): ExprNode | null =>
  window === null
    ? null
    : baseline
      ? sql`time_unix_nano <= ${verbatim(`${window.end}::BIGINT`)}`
      : sql`time_unix_nano BETWEEN ${verbatim(`${window.start}::BIGINT`)} AND ${verbatim(`${window.end}::BIGINT`)}`;

/**
 * The points of the series in the pruned files and the window, with `g0..gN` of their series, the `cell`, and `extra`
 * columns. The series are grouped by `series_id` so a join cannot multiply a point.
 */
function seriesPoints(
  identity: MetricIdentity,
  series: Query,
  files: Pruned,
  window: AbsWindow | null,
  cell: Cell,
  epoch: bigint,
  byCount: number,
  extra: Record<string, ExprNode>,
): Query {
  const keyed = Query.from({ k: series })
    .select({
      sid: sql`series_id`,
      ...Object.fromEntries(groupNames(byCount).map((g) => [g, sql`any_value(${verbatim(g)})`])),
    })
    .groupby(sql`series_id`);
  const terms: ExprNode[] = [sql`series_id = sid`, ...identityTerms(identity)];
  const f = filenameTerm(files);
  if (f !== null) terms.push(f);
  const t = cell.kind === 'time' ? timeTerm(window, cell.baseline) : timeTerm(window, false);
  if (t !== null) terms.push(t);
  return Query.from('points', { s: keyed })
    .select({ ...gSelect(byCount), cell: cellExpr(cell, epoch, window), sid: sql`sid`, ...extra })
    .where(and(...terms));
}

const col = (c: string): ExprNode => sql`${verbatim(c)}`;
const cols = (...names: string[]): Record<string, ExprNode> =>
  Object.fromEntries(names.map((c) => [c, col(c)]));

/**
 * Per (`g0..gN`, `cell`) the aggregate of D25 for `kind`: counter `delta`, `resets`, `n`; number `value` (across series by
 * `show`), `n` (series); hist per `bounds` set `count`, `sum`, `min`, `max`, `counts`; exp `count`, `sum`, `min`, `max`,
 * `scale` (the minimum over rows with a side), `zero_count`, `zero_threshold`, `positive` and `negative` as `list(struct(idx, cnt))`
 * at that scale (entries of count 0 are left out: deltas are never negative and an absent index means 0); summary per `series_id` the last point's `count`, `sum`, `quantiles` and `points`.
 */
export function metricCellsQuery(opts: CellsOptions): Query {
  const { byCount: n, epoch } = opts;
  const pts = (extra: Record<string, ExprNode>): Query =>
    seriesPoints(opts.identity, opts.series, opts.files, opts.window, opts.cell, epoch, n, extra);
  const keys = [...gRefs(n), col('cell')];
  switch (opts.kind) {
    case 'counter':
      return Query.from({ p: pts(cols('delta_value', 'reset')) })
        .select({
          ...gSelect(n),
          cell: col('cell'),
          delta: sql`sum(delta_value)`,
          resets: sql`count(*) FILTER (WHERE reset)`,
          n: sql`count(delta_value)`,
        })
        .groupby(...keys)
        .orderby(...keys);
    case 'number': {
      const m = numberShow(opts.show);
      const per = Query.from({ p: pts(cols('value_double', 'time_unix_nano')) })
        .select({
          ...gSelect(n),
          cell: col('cell'),
          sid: col('sid'),
          a: sql`avg(value_double)`,
          mn: sql`min(value_double)`,
          mx: sql`max(value_double)`,
          lt: sql`arg_max(value_double, time_unix_nano) FILTER (WHERE value_double IS NOT NULL)`,
        })
        .groupby(...keys, col('sid'));
      return Query.from({ q: per })
        .select({
          ...gSelect(n),
          cell: col('cell'),
          value: sql`${verbatim(m.across)}(${verbatim(m.per)})`,
          n: sql`count(${verbatim(m.per)})`,
        })
        .groupby(...keys)
        .orderby(...keys);
    }
    case 'hist':
      return histCells(opts, pts);
    case 'exp':
      return expCells(opts, pts);
    case 'summary':
      return Query.from({ p: pts(cols('count', 'sum', 'quantiles', 'time_unix_nano')) })
        .select({
          ...gSelect(n),
          cell: col('cell'),
          series_id: col('sid'),
          count: sql`arg_max(count, time_unix_nano)`,
          sum: sql`arg_max(sum, time_unix_nano)`,
          quantiles: sql`arg_max(quantiles, time_unix_nano)`,
          points: sql`count(*)`,
        })
        .groupby(...keys, col('sid'))
        .orderby(...keys, col('sid'));
    default:
      return assertNever(opts.kind, 'metric kind');
  }
}

/**
 * Histogram cells (D25): every point contributes one entry per bucket (`idx` from 0) and one `x` row with its scalars;
 * the entries are summed per (group, cell, bounds, idx), then listed in index order. One row per bounds set.
 */
function histCells(opts: CellsOptions, pts: (extra: Record<string, ExprNode>) => Query): Query {
  const n = opts.byCount;
  const keys = [...gRefs(n), col('cell'), col('bounds')];
  const rows = Query.from({
    p: pts({
      ...cols('delta_count', 'delta_value', 'min', 'max'),
      bounds: col('explicit_bounds'),
      dbc: sql`coalesce(delta_bucket_counts, [delta_count])`,
    }),
  })
    .select({ ...gSelect(n), ...cols('cell', 'bounds', 'delta_count', 'delta_value', 'min', 'max', 'dbc') })
    .where(sql`delta_count IS NOT NULL`);
  const nulls = {
    dc: sql`CAST(NULL AS BIGINT)`,
    sm: sql`CAST(NULL AS DOUBLE)`,
    mn: sql`CAST(NULL AS DOUBLE)`,
    mx: sql`CAST(NULL AS DOUBLE)`,
  };
  const unnested = Query.from({ r: rows }).select({
    ...gSelect(n),
    ...cols('cell', 'bounds'),
    e: sql`unnest(list_transform(range(len(dbc)), j -> struct_pack(idx := j, cnt := dbc[j + 1])))`,
  });
  const entries = Query.from({ u: unnested }).select({
    ...gSelect(n),
    ...cols('cell', 'bounds'),
    side: sql`'e'`,
    idx: sql`CAST(e.idx AS INTEGER)`,
    cnt: sql`CAST(e.cnt AS BIGINT)`,
    ...nulls,
  });
  const scalars = Query.from({ r: rows }).select({
    ...gSelect(n),
    ...cols('cell', 'bounds'),
    side: sql`'x'`,
    idx: sql`CAST(NULL AS INTEGER)`,
    cnt: sql`CAST(NULL AS BIGINT)`,
    dc: col('delta_count'),
    sm: col('delta_value'),
    mn: col('min'),
    mx: col('max'),
  });
  const merged = Query.from({ e: Query.unionAll(entries, scalars) })
    .select({
      ...gSelect(n),
      ...cols('cell', 'bounds', 'side', 'idx'),
      cnt: sql`sum(cnt)`,
      dc: sql`sum(dc)`,
      sm: sql`sum(sm)`,
      mn: sql`min(mn)`,
      mx: sql`max(mx)`,
    })
    .groupby(...keys, col('side'), col('idx'));
  return Query.from({ m: merged })
    .select({
      ...gSelect(n),
      cell: col('cell'),
      bounds: col('bounds'),
      count: sql`sum(dc)`,
      sum: sql`sum(sm)`,
      min: sql`min(mn)`,
      max: sql`max(mx)`,
      counts: sql`coalesce(list(cnt ORDER BY idx) FILTER (WHERE side = 'e'), [])`,
    })
    .groupby(...keys)
    .orderby(...keys);
}

/**
 * Exponential cells: every point contributes its per-bucket entries shifted to the cell's smallest scale (`>>` is a
 * floor division for a negative index) plus one `x` row with its scalars; the entries are summed per index, then listed.
 */
function expCells(opts: CellsOptions, pts: (extra: Record<string, ExprNode>) => Query): Query {
  const n = opts.byCount;
  const keys = [...gRefs(n), col('cell')];
  const withScale = Query.from({
    p: pts({
      ...cols(
        'delta_count',
        'delta_value',
        'min',
        'max',
        'delta_scale',
        'delta_zero_count',
        'zero_threshold',
        'delta_positive_offset',
        'delta_positive_counts',
        'delta_negative_offset',
        'delta_negative_counts',
      ),
    }),
  })
    .select({
      ...gSelect(n),
      cell: col('cell'),
      ...cols(
        'delta_count',
        'delta_value',
        'min',
        'max',
        'delta_scale',
        'delta_zero_count',
        'zero_threshold',
        'delta_positive_offset',
        'delta_positive_counts',
        'delta_negative_offset',
        'delta_negative_counts',
      ),
      ms: sql`min(CASE WHEN len(delta_positive_counts) > 0 OR len(delta_negative_counts) > 0 THEN delta_scale END) OVER (PARTITION BY ${verbatim([...groupNames(n), 'cell'].join(', '))})`,
    })
    .where(sql`delta_count IS NOT NULL`);
  const entry = (side: 'p' | 'n'): Query => {
    const off = side === 'p' ? 'delta_positive_offset' : 'delta_negative_offset';
    const cnt = side === 'p' ? 'delta_positive_counts' : 'delta_negative_counts';
    const unnested = Query.from({ r: withScale })
      .select({
        ...gSelect(n),
        cell: col('cell'),
        e: sql`unnest(list_transform(range(len(${verbatim(cnt)})), j -> struct_pack(idx := (${verbatim(off)} + j) >> (delta_scale - coalesce(ms, delta_scale)), cnt := ${verbatim(cnt)}[j + 1])))`,
      })
      .where(sql`len(${verbatim(cnt)}) > 0`);
    return Query.from({ u: unnested }).select({
      ...gSelect(n),
      cell: col('cell'),
      side: sql`${literal(side)}`,
      idx: sql`CAST(e.idx AS INTEGER)`,
      cnt: sql`CAST(e.cnt AS BIGINT)`,
      dc: sql`CAST(NULL AS BIGINT)`,
      sm: sql`CAST(NULL AS DOUBLE)`,
      mn: sql`CAST(NULL AS DOUBLE)`,
      mx: sql`CAST(NULL AS DOUBLE)`,
      zc: sql`CAST(NULL AS BIGINT)`,
      zt: sql`CAST(NULL AS DOUBLE)`,
      sc: sql`CAST(NULL AS INTEGER)`,
    });
  };
  const scalars = Query.from({ r: withScale }).select({
    ...gSelect(n),
    cell: col('cell'),
    side: sql`'x'`,
    idx: sql`CAST(NULL AS INTEGER)`,
    cnt: sql`CAST(NULL AS BIGINT)`,
    dc: col('delta_count'),
    sm: col('delta_value'),
    mn: col('min'),
    mx: col('max'),
    zc: col('delta_zero_count'),
    zt: col('zero_threshold'),
    sc: sql`coalesce(ms, delta_scale)`,
  });
  const entries = Query.unionAll(entry('p'), entry('n'), scalars);
  const merged = Query.from({ e: entries })
    .select({
      ...gSelect(n),
      cell: col('cell'),
      side: col('side'),
      idx: col('idx'),
      cnt: sql`sum(cnt)`,
      dc: sql`sum(dc)`,
      sm: sql`sum(sm)`,
      mn: sql`min(mn)`,
      mx: sql`max(mx)`,
      zc: sql`sum(zc)`,
      zt: sql`max(zt)`,
      sc: sql`min(sc)`,
    })
    .groupby(...keys, col('side'), col('idx'));
  const list = (side: string): ExprNode =>
    sql`coalesce(list(struct_pack(idx := idx, cnt := cnt) ORDER BY idx) FILTER (WHERE side = ${literal(side)} AND cnt <> 0), [])`;
  return Query.from({ m: merged })
    .select({
      ...gSelect(n),
      cell: col('cell'),
      count: sql`sum(dc)`,
      sum: sql`sum(sm)`,
      min: sql`min(mn)`,
      max: sql`max(mx)`,
      scale: sql`min(sc)`,
      zero_count: sql`sum(zc)`,
      zero_threshold: sql`max(zt)`,
      positive: list('p'),
      negative: list('n'),
    })
    .groupby(...keys)
    .orderby(...keys);
}

/** (`g0..gN` of `byCount` columns, `time_ns` relative, `exemplars` JSON) of the points with exemplars, oldest first, at most `limit`. */
export function exemplarsQuery(
  identity: MetricIdentity,
  series: Query,
  files: Pruned,
  window: AbsWindow | null,
  epoch: bigint,
  limit: number,
  byCount: number,
): Query {
  const rows = seriesPoints(
    identity,
    series,
    files,
    window,
    { kind: 'time', widthNs: 1, baseline: false },
    epoch,
    byCount,
    { time_unix_nano: col('time_unix_nano'), exemplars: col('exemplars') },
  );
  return Query.from({ p: rows })
    .select({ ...gSelect(byCount), time_ns: relTime('time_unix_nano', epoch), exemplars: col('exemplars') })
    .where(sql`exemplars IS NOT NULL`)
    .orderby(col('time_unix_nano'), col('sid'))
    .limit(limit);
}

/**
 * Per run (`g0` of `series`, built with the `runBy` expression): `t`, the relative time of its latest point, `revision`
 * (D28) of that point and `n_series`; plus the row with `run IS NULL` whose `left_out` counts the series with a NULL or empty run value.
 */
export function runsQuery(identity: MetricIdentity, series: Query, files: Pruned, epoch: bigint): Query {
  const rows = seriesPoints(
    identity,
    series,
    files,
    null,
    { kind: 'time', widthNs: 1, baseline: false },
    epoch,
    1,
    {
      time_unix_nano: col('time_unix_nano'),
      revision: sql`json_extract_string(resource_attributes, '/vcs.ref.head.revision')`,
    },
  );
  const empty = sql`(g0 IS NULL OR g0 IN ('""', 'null'))`;
  const runs = Query.from({ p: rows })
    .select({
      run: col('g0'),
      t: sql`max(time_unix_nano) - ${verbatim(`${epoch}::BIGINT`)}`,
      revision: sql`arg_max(revision, time_unix_nano)`,
      n_series: sql`count(DISTINCT sid)`,
      left_out: sql`0`,
    })
    .where(sql`NOT ${empty}`)
    .groupby(col('g0'));
  const left = Query.from({ p: rows }).select({
    run: sql`CAST(NULL AS VARCHAR)`,
    t: sql`CAST(NULL AS BIGINT)`,
    revision: sql`CAST(NULL AS VARCHAR)`,
    n_series: sql`0`,
    left_out: sql`count(DISTINCT sid) FILTER (WHERE ${empty})`,
  });
  return Query.from({ u: Query.unionAll(runs, left) })
    .select({ ...cols('run', 't', 'revision', 'n_series', 'left_out') })
    .orderby(sql`run IS NULL`, col('t'), col('run'));
}
