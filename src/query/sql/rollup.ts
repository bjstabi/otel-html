import { column, type ExprNode, literal, Query, sql, star, verbatim } from '@uwdata/mosaic-sql';
import {
  type ManifestV4,
  type PartitionFile,
  ROLLUP_GRAIN_NS,
  type RollupDescription,
} from '../../format/manifest.js';
import { OtelHtmlError } from '../../model/errors.js';
import { jsonStringAt } from './columns.js';
import { CORE_SPAN_FACETS, type CoreFacet, truncated } from './facets.js';
import { type SqlFilter, whereOf } from './filter.js';
import { bandExpr } from './logs.js';
import type { PruneHints } from './ottl.js';
import { type AbsWindow, type Pruned, prunePartitions } from './prune.js';
import { durationBucketsQuery } from './spans.js';
import { type BucketSpec, bucketExpr } from './time.js';

/**
 * Rollups answer a request the router sends to `measures` (`src/viewer/data/route.ts`): one relation holds the rollup
 * rows of the partitions that have a usable rollup, `UNION ALL` the same shape grouped from the raw files of the
 * others, and the request's statement aggregates it. Nothing here names a widget, a dashboard or a CI key.
 */

/** A column of the measures relation: `raw` is its expression over the base table, `rollup` over the rollup table when that stores it otherwise. */
export interface MeasureKey {
  /** The relation's column name. */
  name: string;
  raw: ExprNode;
  rollup?: ExprNode;
  /** What a rollup must hold (its dimensions, in the statistics-key grammar) to carry this key; absent for the time column, which every rollup has. */
  reads?: string;
}

/** The file paths of one request: rollup files, and the base-table files of the partitions without a usable rollup. */
export interface Split {
  rollup: readonly string[];
  raw: readonly string[];
}

type Table = 'spans' | 'logs';
const ROLLUP_TABLE = { spans: 'span_rollups', logs: 'log_rollups' } as const;

/** Pruning of the rollup files themselves: the hints and window that pruned the base files, and the long-window rule. */
export interface RollupPrune {
  hints: PruneHints;
  window: AbsWindow | null;
  long: boolean;
}

/** `r` can answer a request that reads `reads` (and asks for durations when `durations`). */
function usable(r: PartitionFile | undefined, reads: ReadonlySet<string>, durations: boolean): boolean {
  const d: RollupDescription | undefined = r?.rollup;
  if (d === undefined || d.grainNs !== ROLLUP_GRAIN_NS) return false;
  if (durations && d.durationBuckets !== 'log2x8') return false;
  const have = new Set(d.dimensions);
  for (const key of reads) if (!have.has(key)) return false;
  return true;
}

/**
 * Which files answer a request over `pruned`, the base files its filter kept. A partition's rollup is usable when its
 * description's dimensions hold everything the request reads, its grain is `ROLLUP_GRAIN_NS` and, if durations are
 * asked, its duration buckets are `log2x8`; the partition then reads its rollup file. Any other partition (a format-4
 * partition, or a rollup that lacks a dimension) reads its base file. `rawOnly` sends every file to `raw`.
 *
 * The dimension rule comes before the statistics: a rollup file's statistics record no value for a key that is not
 * among its own dimensions, so a rollup is pruned by `opts.prune` (the hints and window, through `prunePartitions`) only
 * once it is known to hold the keys it is pruned by; the partition of a rollup that does not goes to `raw`, never away.
 */
export function splitFiles(
  manifest: ManifestV4,
  table: Table,
  pruned: Pruned,
  reads: ReadonlySet<string>,
  opts: { durations: boolean; rawOnly: boolean; prune?: RollupPrune },
): Split {
  if (opts.rawOnly) return { rollup: [], raw: pruned.files };
  const rollupTable = ROLLUP_TABLE[table];
  const wanted = new Set(pruned.files);
  const { prune } = opts;
  const kept =
    prune === undefined
      ? null
      : new Set(
          prunePartitions(manifest, rollupTable, prune.hints, prune.window, undefined, { long: prune.long })
            .files,
        );
  const rollup: string[] = [];
  const raw: string[] = [];
  for (const partition of manifest.partitions) {
    const base = partition.files[table];
    if (base === undefined || !wanted.has(base.path)) continue;
    const r = partition.files[rollupTable];
    if (r === undefined || !usable(r, reads, opts.durations)) raw.push(base.path);
    else if (kept === null || kept.has(r.path)) rollup.push(r.path);
  }
  return { rollup, raw };
}

const GRAIN = verbatim(`${ROLLUP_GRAIN_NS}::BIGINT`);
const floorToGrain = (t: ExprNode): ExprNode => sql`(${t} - ((${t} % ${GRAIN}) + ${GRAIN}) % ${GRAIN})`;

/**
 * The time column `t` of the relation: the start of the grain of a span's start, of a log's effective time (a log with
 * no time at all is at the epoch, where the raw timeline puts it).
 */
export function timeKey(table: Table, epoch: bigint): MeasureKey {
  const at = verbatim(`${epoch}::BIGINT`);
  if (table === 'spans') {
    return {
      name: 't',
      raw: floorToGrain(column('start_time_unix_nano')),
      rollup: column('start_time_unix_nano'),
    };
  }
  const effective = sql`coalesce(${column('time_unix_nano')}, ${column('observed_time_unix_nano')})`;
  return {
    name: 't',
    raw: sql`coalesce(${floorToGrain(effective)}, ${at})`,
    rollup: sql`coalesce(${effective}, ${at})`,
  };
}

export const SERVICE_KEY: MeasureKey = {
  name: 'service_name',
  raw: column('service_name'),
  reads: 'service_name',
};
export const STATUS_KEY: MeasureKey = {
  name: 'status_code',
  raw: column('status_code'),
  reads: 'status_code',
};
/** The severity band of a log (`bandExpr`). */
export const BAND_KEY: MeasureKey = { name: 'band', raw: bandExpr(), reads: 'severity_number' };

/** What `keys` read: the dimensions a rollup must hold to carry them. */
export const readsOf = (keys: readonly MeasureKey[]): string[] => keys.flatMap((k) => k.reads ?? []);

/** A core facet as a column named by the facet's key. */
export function facetKeyOf(f: CoreFacet): MeasureKey {
  return {
    name: f.key,
    raw: f.expr,
    ...(f.rollupExpr === undefined ? {} : { rollup: f.rollupExpr }),
    reads: f.reads,
  };
}

/** The grouping key of a `groups` request: a core facet of the spans, else the span attribute of that name. Named `value`. */
export function groupKeyOf(key: string): MeasureKey {
  const core = CORE_SPAN_FACETS.find((c) => c.key === key);
  if (core !== undefined) {
    return {
      name: 'value',
      raw: truncated(core.expr),
      ...(core.rollupExpr === undefined ? {} : { rollup: truncated(core.rollupExpr) }),
      reads: core.reads,
    };
  }
  return { name: 'value', raw: truncated(jsonStringAt('attributes', [key])), reads: `attr:${key}` };
}

const SERVICE_NAME = 'service.name';
/** Whether the resource had no `service.name` of its own: `serviceName` (`src/semconv/resource-name.ts`) then makes `unknown_service[:<executable>]`. */
const UNNAMED = sql`(service_name = 'unknown_service' OR starts_with(service_name, 'unknown_service:'))`;

/**
 * The rollup table as the predicate of a condition reads it. A rollup keeps the service as the column `service_name`
 * and reduces `resource_attributes` to the other dimensions, but `resource.attributes["service.name"]` translates to
 * a read of that JSON; with a predicate the branch reads the table with the key put back, so the predicate runs unchanged.
 */
function rollupSource(table: Table, withPredicate: boolean): Query | string {
  if (!withPredicate) return ROLLUP_TABLE[table];
  const restored = sql`CASE WHEN ${UNNAMED} THEN resource_attributes ELSE json_merge_patch(coalesce(resource_attributes, '{}'), json_object(${literal(SERVICE_NAME)}, service_name)) END`;
  return Query.from(ROLLUP_TABLE[table]).select(star(null, { replace: { resource_attributes: restored } }));
}

const selectOf = (keys: readonly MeasureKey[], branch: 'raw' | 'rollup'): Record<string, ExprNode> =>
  Object.fromEntries(keys.map((k) => [k.name, branch === 'rollup' ? (k.rollup ?? k.raw) : k.raw]));

/**
 * Rows (…keys, n and, for spans when `durations`, duration_bucket, duration_sum, duration_min, duration_max): the rollup
 * rows of `split.rollup` `UNION ALL` the same shape grouped from `split.raw`. The rollup branch applies the filter's
 * predicate and window (a text search or a residual condition is never answered from a rollup: the router sends every
 * file to `raw`); the raw branch applies the whole filter the request runs with. A relation with no file at all
 * is the raw branch over none, which is empty. With `durations` false the rows hold the keys and `n` only, so a count
 * reads no duration column.
 */
export function measuresRelation(
  f: SqlFilter,
  table: Table,
  split: Split,
  keys: readonly MeasureKey[],
  durations: boolean,
): Query {
  if (!f.long && f.window !== null) {
    throw new OtelHtmlError('usage', {
      message: 'measuresRelation: a window is read as a rollup only under the long-window rules',
    });
  }
  const branches: Query[] = [];
  if (split.rollup.length > 0) {
    const own: SqlFilter = {
      ...f,
      text: null,
      files: { files: split.rollup, all: false, total: split.rollup.length },
    };
    const measures: Record<string, ExprNode> =
      table === 'spans' && durations
        ? {
            duration_bucket: column('duration_bucket'),
            n: column('n'),
            duration_sum: column('duration_sum'),
            duration_min: column('duration_min'),
            duration_max: column('duration_max'),
          }
        : { n: column('n') };
    branches.push(
      Query.from(rollupSource(table, f.predicate !== null))
        .select(selectOf(keys, 'rollup'), measures)
        .where(...whereOf(own, table)),
    );
  }
  if (split.raw.length > 0 || branches.length === 0) {
    const own: SqlFilter = {
      ...f,
      files: { files: split.raw, all: split.raw.length === f.files.total, total: f.files.total },
    };
    branches.push(
      table === 'spans'
        ? durationBucketsQuery(
            own,
            keys.map((k) => ({ name: k.name, raw: k.raw })),
            durations,
          )
        : Query.from('logs')
            .select(selectOf(keys, 'raw'), { n: sql`count(*)` })
            .where(...whereOf(own, 'logs'))
            .groupby(sql`ALL`),
    );
  }
  const [only] = branches;
  return branches.length === 1 && only !== undefined ? only : Query.unionAll(branches);
}

const ident = (name: string): string => String(column(name));
const n64 = (e: ExprNode | string): ExprNode => sql`CAST(coalesce(sum(${verbatim(String(e))}), 0) AS BIGINT)`;
const sumWhere = (cond: ExprNode): ExprNode =>
  sql`CAST(coalesce(sum(n) FILTER (WHERE ${cond}), 0) AS BIGINT)`;

/** `total`: the number of rows the relation stands for. */
export function rollupTotalQuery(rel: Query): Query {
  return Query.from({ r: rel }).select({ total: n64('n') });
}

const IS_ERROR = sql`status_code = 2`;
const STATUS_COUNTS: Record<string, ExprNode> = {
  errors: IS_ERROR,
  ok: sql`status_code = 1`,
  error: IS_ERROR,
  unset: sql`status_code IS NULL OR status_code NOT IN (1, 2)`,
};

/** The representative duration of bucket `b`, 2^((b + 0.5) / 8) (`bucketValue` in `src/format/parquet/duration-bucket.ts`); 0 for the bucket of zero or less. */
const representative = (b: string): string =>
  `CASE WHEN ${b} < 0 THEN 0.0 ELSE power(2, (${b} + 0.5) / 8.0) END`;

/**
 * `rel` grouped by `by` (output column to expression over the relation), with `n`, the named conditional counts,
 * `sum_duration_ns` (DOUBLE), `min_duration_ns`, `max_duration_ns` and `quantiles` (p50, p95, p99): the representative
 * duration of the duration bucket holding the rank `floor(p * (n - 1)) + 1`, clamped to [min, max]. The relation must
 * have been built with durations.
 */
function summarised(
  rel: Query,
  by: Record<string, ExprNode>,
  counts: Record<string, ExprNode>,
  where?: ExprNode,
): Query {
  const names = Object.keys(by);
  const countNames = Object.keys(counts);
  const part = names.length === 0 ? '' : `PARTITION BY ${names.map(ident).join(', ')}`;
  const perBucket = Query.from({ r: rel })
    .select(by, {
      duration_bucket: column('duration_bucket'),
      n: sql`sum(n)`,
      ...Object.fromEntries(countNames.map((c) => [c, sql`sum(n) FILTER (WHERE ${counts[c] ?? sql`true`})`])),
      dsum: sql`sum(duration_sum)`,
      dmin: sql`min(duration_min)`,
      dmax: sql`max(duration_max)`,
    })
    .groupby(...names, 'duration_bucket');
  if (where !== undefined) perBucket.where(where);
  const running = Query.from({ h: perBucket }).select('*', {
    cum: sql`CAST(sum(n) OVER (${verbatim(part)} ORDER BY duration_bucket) AS BIGINT)`,
    tot: sql`CAST(sum(n) OVER (${verbatim(part)}) AS BIGINT)`,
  });
  const rank = (p: number): ExprNode =>
    sql`min(duration_bucket) FILTER (WHERE cum >= floor(${verbatim(String(p))} * (tot - 1)) + 1)`;
  const grouped = Query.from({ c: running }).select(Object.fromEntries(names.map((nm) => [nm, column(nm)])), {
    n: n64('n'),
    ...Object.fromEntries(countNames.map((c) => [c, n64(c)])),
    sum_duration_ns: sql`CAST(sum(dsum) AS DOUBLE)`,
    min_duration_ns: sql`min(dmin)`,
    max_duration_ns: sql`max(dmax)`,
    b50: rank(0.5),
    b95: rank(0.95),
    b99: rank(0.99),
  });
  if (names.length > 0) grouped.groupby(...names);
  const clamp = (b: string): string =>
    `least(greatest(${representative(b)}, min_duration_ns), max_duration_ns)`;
  return Query.from({ g: grouped }).select(
    Object.fromEntries(names.map((nm) => [nm, column(nm)])),
    'n',
    ...countNames,
    'sum_duration_ns',
    'min_duration_ns',
    'max_duration_ns',
    { quantiles: verbatim(`[${clamp('b50')}, ${clamp('b95')}, ${clamp('b99')}]`) },
  );
}

/**
 * Per bucket of `spec` (relative ns, `bucketExpr` over the relation's `t`): for spans, `n`, `errors`, `ok` / `error` /
 * `unset`, and with `latency` (the default) `quantiles` and `max_duration_ns` from the duration buckets, so the relation
 * needs durations then. With `by` (a key of the relation) rows are (by.name, bucket, n) instead, for the values in
 * `only` when given; that is how the logs' severity bands and a service's buckets are asked.
 */
export function rollupTimelineQuery(
  rel: Query,
  spec: BucketSpec,
  epoch: bigint,
  by: MeasureKey | null,
  opts: { latency?: boolean; only?: readonly string[] } = {},
): Query {
  const bucket = bucketExpr('t', spec, epoch);
  if (by !== null) {
    const q = Query.from({ r: rel })
      .select({ [by.name]: column(by.name), bucket, n: n64('n') })
      .groupby(by.name, sql`bucket`)
      .orderby(sql`bucket`, by.name);
    if (opts.only === undefined) return q;
    return q.where(
      opts.only.length === 0
        ? literal(false)
        : sql`${column(by.name)} IN (${verbatim(opts.only.map((v) => String(literal(v))).join(', '))})`,
    );
  }
  if (opts.latency === false) {
    return Query.from({ r: rel })
      .select({
        bucket,
        n: n64('n'),
        ...Object.fromEntries(Object.entries(STATUS_COUNTS).map(([k, cond]) => [k, sumWhere(cond)])),
      })
      .groupby(sql`bucket`)
      .orderby(sql`bucket`);
  }
  return summarised(rel, { bucket }, STATUS_COUNTS).orderby(sql`bucket`);
}

/**
 * Rows (key, value, n, total) like `coreFacetsQuery` for one key: `value` is the key cut to the facet value length, a
 * row with no value is skipped, `cap` values by count then text, `total` counts every value.
 */
export function rollupFacetQuery(rel: Query, key: MeasureKey, cap: number): Query {
  const grouped = Query.from({ r: rel })
    .select({ value: truncated(column(key.name)), n: n64('n') })
    .where(sql`${column(key.name)} IS NOT NULL`)
    .groupby(sql`value`);
  return Query.from({ grouped })
    .select({
      key: literal(key.name),
      value: column('value'),
      n: column('n'),
      total: sql`CAST(sum(n) OVER () AS BIGINT)`,
    })
    .qualify(sql`row_number() OVER (ORDER BY n DESC, value) <= ${literal(cap)}`)
    .orderby(sql`n DESC`, sql`value`);
}

/**
 * Per value of `keys` (the relation needs `status_code` and durations): the key columns, `n`, `errors`,
 * `sum_duration_ns`, `quantiles` and `max_duration_ns`, most frequent first, `limit` rows. With `nonNull` a null key is skipped.
 */
export function rollupGroupsQuery(
  rel: Query,
  keys: readonly MeasureKey[],
  opts: { limit?: number; nonNull?: boolean } = {},
): Query {
  const names = keys.map((k) => k.name);
  const where =
    opts.nonNull === true && names.length > 0
      ? sql`${verbatim(names.map((nm) => `${ident(nm)} IS NOT NULL`).join(' AND '))}`
      : undefined;
  const q = summarised(
    rel,
    Object.fromEntries(names.map((nm) => [nm, column(nm)])),
    { errors: IS_ERROR },
    where,
  ).orderby(sql`n DESC`, ...names.map((nm) => column(nm)));
  return opts.limit === undefined ? q : q.limit(opts.limit);
}

/** One row: `n`, `sum_duration_ns`, `min_duration_ns`, `max_duration_ns` and `quantiles`, from the duration buckets. */
export function rollupDurationsQuery(rel: Query): Query {
  return summarised(rel, {}, {});
}

/** Exact bins of `axis` like `durationBinsQuery`, but of each duration bucket's representative duration: rows (bin, n). */
export function rollupDurationBinsQuery(
  rel: Query,
  axis: readonly { fromNs: number; toNs: number }[],
): Query {
  const inner = axis.slice(0, -1).map((b) => b.toNs);
  const bin =
    inner.length === 0
      ? sql`0`
      : sql`CAST(len(list_filter(${verbatim(`[${inner.join(', ')}]`)}, (e) -> e <= ${verbatim(representative('duration_bucket'))})) AS INTEGER)`;
  const q = Query.from({ r: rel })
    .select({ bin, n: n64('n') })
    .groupby(sql`bin`)
    .orderby(sql`bin`);
  return axis.length === 0 ? q.where(literal(false)) : q;
}
