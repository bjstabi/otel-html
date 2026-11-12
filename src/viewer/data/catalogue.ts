import { OtelHtmlError } from '../../model/errors.js';
import { parseTraceId } from '../../model/ids.js';
import type { MetricQuery } from '../../query/metric-query.js';
import { DEFAULT_LOG_FACETS, DEFAULT_SPAN_FACETS } from '../../semconv/default-facets.js';
import type { DataSource } from './data-source.js';
import { parseLogRef } from './log-query.js';
import type { LogNeed, LogQuery, SpanNeed, SpanQuery } from './results.js';
import type { TimeWindow } from './time-window.js';

/**
 * The closed list of requests the viewer's `DataSource` can make: one runnable entry per query shape. Nothing in the
 * viewer imports it; the scaling tests do, to measure what each request reads and to prove no request is missing.
 */

/** The cost class a request may have on one growth axis (§3.2); the budget table in the scaling tests assigns them. */
export type CostClass = 'fixed' | 'files' | 'matched' | 'scan';
/** The three axes the report grows along; the generator steps them. */
export type Axis = 'retention' | 'density' | 'window';
export type Family =
  | 'count'
  | 'time buckets'
  | 'top values'
  | 'group statistics'
  | 'duration distribution'
  | 'rows page'
  | 'trace list'
  | 'read by id'
  | 'distinct values'
  | 'patterns'
  | 'metrics';

/** One existing value of each kind the point reads and the conditions need (the generator's report holds them). */
export interface ScalingIds {
  traceId: string;
  spanId: string;
  logRef: string;
  service: string;
  resource: string;
  runId: string;
  route: string;
  text: string;
  metric: string;
}

export interface CatalogueContext {
  /** Null for an entry with `window: false`. */
  window: TimeWindow | null;
  ids: ScalingIds;
}

export interface CatalogueEntry {
  id: string;
  family: Family;
  method: keyof DataSource;
  needs?: readonly (SpanNeed | LogNeed)[];
  /** Exported names of the `src/query/sql/` builders this request runs, exactly. */
  builders: readonly string[];
  spacing: 'dense' | 'sparse';
  /** False: the request carries no window and the window axis is n/a. */
  window: boolean;
  run(ds: DataSource, ctx: CatalogueContext): Promise<unknown>;
}

type Entry<M extends keyof DataSource> = CatalogueEntry & { method: M };

/** Only the generator's keys: a sort key, a statistics key, an attribute and a text. */
interface Condition {
  condition: string | null;
  text: string;
}
const NONE: Condition = { condition: null, text: '' };
const SORT_KEY = (ids: ScalingIds): Condition => ({
  condition: `resource.attributes["service.name"] == "${ids.service}"`,
  text: '',
});
const STAT_KEY = (ids: ScalingIds): Condition => ({
  condition: `resource.attributes["run.id"] == "${ids.runId}"`,
  text: '',
});
const ATTR = (ids: ScalingIds): Condition => ({
  condition: `attributes["http.route"] == "${ids.route}"`,
  text: '',
});
/** A term SQL cannot express exactly: the condition runs through an id table (D5). */
const RESIDUAL = (): Condition => ({ condition: 'Len(name) > 1', text: '' });
const TEXT = (ids: ScalingIds): Condition => ({ condition: null, text: ids.text });

const CORE_SPAN_KEYS = DEFAULT_SPAN_FACETS.map((f) => f.key);
const CORE_LOG_KEYS = DEFAULT_LOG_FACETS.map((f) => f.key);
const SURROUNDING = 5;
const DURATION_NS = 1_000_000;

/** `.short` is dense with a window, `.long` sparse with a window, `.all` dense without, `.all.long` sparse without. */
interface Variant {
  suffix: string;
  spacing: 'dense' | 'sparse';
  window: boolean;
}
const SHORT: Variant = { suffix: 'short', spacing: 'dense', window: true };
const LONG: Variant = { suffix: 'long', spacing: 'sparse', window: true };
const ALL: Variant = { suffix: 'all', spacing: 'dense', window: false };
const ALL_LONG: Variant = { suffix: 'all.long', spacing: 'sparse', window: false };
const WINDOWED = [SHORT, LONG] as const;

const spanQuery = (over: Partial<SpanQuery>): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 100,
  groupBy: null,
  measureBy: null,
  needs: ['rows'],
  facetKeys: null,
  ...over,
});
const logQuery = (over: Partial<LogQuery>): LogQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'logs',
  sort: { column: 'time', dir: 'asc' },
  limit: 100,
  needs: ['rows'],
  facetKeys: null,
  ...over,
});

interface SpanSpec {
  id: string;
  family: Family;
  needs: readonly SpanNeed[];
  builders: readonly string[];
  over?: Partial<SpanQuery>;
  when?: (ids: ScalingIds) => Condition;
  variants?: readonly Variant[];
}

function spanEntries(specs: readonly SpanSpec[]): Entry<'querySpans'>[] {
  return specs.flatMap((s) =>
    (s.variants ?? WINDOWED).map(
      (v): Entry<'querySpans'> => ({
        id: `${s.id}.${v.suffix}`,
        family: s.family,
        method: 'querySpans',
        needs: s.needs,
        builders: s.builders,
        spacing: v.spacing,
        window: v.window,
        run: (ds, ctx) =>
          ds.querySpans(
            spanQuery({
              ...(s.when?.(ctx.ids) ?? NONE),
              ...s.over,
              needs: s.needs,
              window: v.window ? ctx.window : null,
            }),
          ),
      }),
    ),
  );
}

interface LogSpec {
  id: string;
  family: Family;
  needs: readonly LogNeed[];
  builders: readonly string[];
  over?: Partial<LogQuery>;
  when?: (ids: ScalingIds) => Condition;
  variants?: readonly Variant[];
}

function logEntries(specs: readonly LogSpec[]): Entry<'queryLogs'>[] {
  return specs.flatMap((s) =>
    (s.variants ?? WINDOWED).map(
      (v): Entry<'queryLogs'> => ({
        id: `${s.id}.${v.suffix}`,
        family: s.family,
        method: 'queryLogs',
        needs: s.needs,
        builders: s.builders,
        spacing: v.spacing,
        window: v.window,
        run: (ds, ctx) =>
          ds.queryLogs(
            logQuery({
              ...(s.when?.(ctx.ids) ?? NONE),
              ...s.over,
              needs: s.needs,
              window: v.window ? ctx.window : null,
            }),
          ),
      }),
    ),
  );
}

const span = (
  id: string,
  needs: readonly SpanNeed[],
  builders: readonly string[],
  rest: Partial<SpanSpec> = {},
) => ({
  id,
  family: 'count' as Family,
  needs,
  builders,
  ...rest,
});

const SPAN_AGGREGATES: SpanSpec[] = [
  span('spans.total', ['total'], ['spanCountQuery']),
  { ...span('spans.buckets', ['buckets'], ['timelineQuery']), family: 'time buckets' },
  { ...span('spans.timeline', ['timeline'], ['timelineQuery']), family: 'time buckets' },
  {
    ...span('spans.facets.core', ['facets'], ['coreFacetsQuery'], { over: { facetKeys: CORE_SPAN_KEYS } }),
    family: 'top values',
  },
  {
    ...span('spans.facets.attr', ['facets'], ['coreFacetsQuery', 'attributeFacetsQuery']),
    family: 'top values',
  },
  {
    ...span('spans.groups', ['groups'], ['groupStatsQuery'], { over: { measureBy: 'service.name' } }),
    family: 'group statistics',
  },
  {
    ...span('spans.durations', ['durations'], ['durationSummaryQuery', 'durationBinsQuery']),
    family: 'duration distribution',
  },
];

const CONDITIONS: readonly [string, (ids: ScalingIds) => Condition][] = [
  ['sortkey', SORT_KEY],
  ['statkey', STAT_KEY],
  ['attr', ATTR],
  ['text', TEXT],
];
const SPAN_CONDITIONS: SpanSpec[] = [
  ...CONDITIONS.map(([c, when]) => span(`spans.total.${c}`, ['total'], ['spanCountQuery'], { when })),
  span(
    'spans.total.residual',
    ['total'],
    ['spanCountQuery', 'spanRowsQuery', 'idTableStatement', 'idTableRowsQuery'],
    {
      when: RESIDUAL,
    },
  ),
  span('spans.total.traces', ['total'], ['spanCountQuery'], {
    over: { mode: 'traces' },
    variants: [LONG],
  }),
];

const SPAN_ROWS: SpanSpec[] = [
  {
    ...span('spans.rows', ['rows'], ['spanRowsQuery']),
    family: 'rows page',
    variants: [SHORT, LONG, ALL],
  },
];

const TRACE_LIST: SpanSpec[] = [
  {
    ...span('traces.list', ['rows'], ['traceRowsQuery'], { over: { mode: 'traces' } }),
    family: 'trace list',
    variants: [ALL, ALL_LONG, SHORT, LONG],
  },
  {
    ...span('traces.list.statkey', ['rows'], ['traceRowsQuery'], {
      over: { mode: 'traces' },
      when: STAT_KEY,
    }),
    family: 'trace list',
    variants: [LONG],
  },
  {
    ...span('traces.list.attr', ['rows'], ['traceRowsQuery'], { over: { mode: 'traces' }, when: ATTR }),
    family: 'trace list',
    variants: [LONG],
  },
];

const log = (
  id: string,
  family: Family,
  needs: readonly LogNeed[],
  builders: readonly string[],
  rest: Partial<LogSpec> = {},
): LogSpec => ({ id, family, needs, builders, ...rest });

const LOG_QUERIES: LogSpec[] = [
  log('logs.timeline', 'time buckets', ['timeline'], ['logTimelineQuery']),
  log('logs.facets.core', 'top values', ['facets'], ['coreFacetsQuery'], {
    over: { facetKeys: CORE_LOG_KEYS },
  }),
  log('logs.facets.attr', 'top values', ['facets'], ['coreFacetsQuery', 'attributeFacetsQuery']),
  log('logs.rows', 'rows page', ['rows'], ['logRowsQuery']),
  log('logs.traces', 'trace list', ['rows'], ['logTracesQuery', 'logsWithTraceCountQuery'], {
    over: { mode: 'traces', sort: { column: 'first', dir: 'asc' } },
  }),
  log('logs.timeline.statkey', 'time buckets', ['timeline'], ['logTimelineQuery'], { when: STAT_KEY }),
  log('logs.timeline.text', 'time buckets', ['timeline'], ['logTimelineQuery'], {
    when: TEXT,
    variants: [LONG],
  }),
];

function windowOf(ctx: CatalogueContext): TimeWindow {
  if (ctx.window === null)
    throw new OtelHtmlError('usage', { message: 'this catalogue entry carries a window' });
  return ctx.window;
}

const entry = <M extends keyof DataSource>(e: Entry<M>): Entry<M> => e;

/** An entry for a request with no window and no growth in spacing: dense, `window: false`. */
function point<M extends keyof DataSource>(
  e: Omit<CatalogueEntry, 'spacing' | 'window' | 'method'> & { method: M },
): Entry<M> {
  return { spacing: 'dense', window: false, ...e };
}

const metricQueryOf = (ids: ScalingIds, where: string | null = null): MetricQuery => ({
  id: 'q',
  metric: ids.metric,
  kind: null,
  unit: null,
  show: 'avg',
  by: [],
  where,
  fn: [],
  alias: null,
  hidden: false,
});

async function metricEntryOf(ds: DataSource, ids: ScalingIds, name: string = ids.metric) {
  const found = (await ds.metricCatalog()).entries.find((e) => e.name === name);
  if (found === undefined) throw new OtelHtmlError('usage', { message: `no metric ${name} in the report` });
  return found;
}

const traceIdOf = (ids: ScalingIds) => parseTraceId(ids.traceId, 'catalogue.traceId');

const SERVICES: readonly Entry<'services'>[] = WINDOWED.map(
  (v): Entry<'services'> => ({
    id: `spans.services.${v.suffix}`,
    family: 'group statistics',
    method: 'services',
    builders: ['servicesQuery', 'serviceBucketsQuery'],
    spacing: v.spacing,
    window: true,
    run: (ds, ctx) => ds.services({ window: ctx.window, condition: null, limit: 10 }),
  }),
);

const PERCENTILE: readonly Entry<'percentileOf'>[] = WINDOWED.map(
  (v): Entry<'percentileOf'> => ({
    id: `percentile.${v.suffix}`,
    family: 'duration distribution',
    method: 'percentileOf',
    builders: ['percentileQuery'],
    spacing: v.spacing,
    // the percentile reads the service and resource's spans whatever the page's window
    window: false,
    run: (ds, ctx) => ds.percentileOf(ctx.ids.service, ctx.ids.resource, DURATION_NS),
  }),
);

/** What the first metric request of a source reads: the catalog (memoised after). */
const METRIC_CATALOG = ['metricDefsQuery', 'metricIdentitiesQuery', 'metricSparkQuery'] as const;
const METRIC_QUERY = [
  'metricCellsQuery',
  'exemplarsQuery',
  'pointIntervalQuery',
  'seriesQuery',
  'seriesServicesQuery',
] as const;

const METRIC_QUERIES: readonly Entry<'metricQuery'>[] = WINDOWED.map(
  (v): Entry<'metricQuery'> => ({
    id: `metrics.query.${v.suffix}`,
    family: 'metrics',
    method: 'metricQuery',
    builders: [...METRIC_CATALOG, ...METRIC_QUERY],
    spacing: v.spacing,
    window: true,
    run: async (ds, ctx) =>
      ds.metricQuery({
        entry: await metricEntryOf(ds, ctx.ids),
        query: metricQueryOf(ctx.ids),
        window: windowOf(ctx),
        maxPoints: 300,
        exemplars: true,
      }),
  }),
);

export const CATALOGUE = [
  ...spanEntries(SPAN_AGGREGATES),
  ...SERVICES,
  ...spanEntries(SPAN_CONDITIONS),
  ...spanEntries(SPAN_ROWS),
  ...PERCENTILE,
  ...spanEntries(TRACE_LIST),
  point({
    id: 'trace.get',
    family: 'read by id',
    method: 'getTrace',
    builders: ['tracePartitionsQuery', 'traceSpansQuery', 'traceSummaryQuery'],
    run: (ds, ctx) => ds.getTrace(traceIdOf(ctx.ids)),
  }),
  point({
    id: 'trace.share',
    family: 'read by id',
    method: 'serviceShare',
    builders: ['tracePartitionsQuery', 'traceSpansQuery'],
    run: (ds, ctx) => ds.serviceShare(traceIdOf(ctx.ids)),
  }),
  point({
    id: 'trace.has',
    family: 'read by id',
    method: 'hasTrace',
    builders: ['tracePartitionsQuery'],
    run: (ds, ctx) => ds.hasTrace(traceIdOf(ctx.ids)),
  }),
  point({
    id: 'trace.logs',
    family: 'read by id',
    method: 'traceLogs',
    builders: ['traceLogsQuery', 'tracePartitionsQuery'],
    run: (ds, ctx) => ds.traceLogs(traceIdOf(ctx.ids)),
  }),
  point({
    id: 'log.get',
    family: 'read by id',
    method: 'getLog',
    builders: ['logByRefQuery'],
    run: (ds, ctx) => ds.getLog(parseLogRef(ctx.ids.logRef, 'catalogue.logRef')),
  }),
  point({
    id: 'log.surrounding',
    family: 'read by id',
    method: 'surroundingLogs',
    builders: ['logByRefQuery', 'surroundingQueries'],
    run: (ds, ctx) => ds.surroundingLogs(parseLogRef(ctx.ids.logRef, 'catalogue.logRef'), SURROUNDING),
  }),
  ...logEntries(LOG_QUERIES),
  point({
    id: 'resourceValues.all',
    family: 'distinct values',
    method: 'resourceValues',
    builders: ['resourceValuesQuery'],
    run: (ds) => ds.resourceValues('service.name'),
  }),
  point({
    id: 'patterns',
    family: 'patterns',
    method: 'patterns',
    builders: ['patternsQuery'],
    run: (ds) => ds.patterns({ window: null, sort: { column: 'count', dir: 'desc' }, limit: 100 }),
  }),
  point({
    id: 'metrics.catalog',
    family: 'metrics',
    method: 'metricCatalog',
    builders: ['metricDefsQuery', 'metricIdentitiesQuery', 'metricSparkQuery'],
    run: (ds) => ds.metricCatalog(),
  }),
  point({
    id: 'metrics.showOptions',
    family: 'metrics',
    method: 'metricShowOptions',
    builders: ['metricDefsQuery', 'metricIdentitiesQuery', 'metricSparkQuery'],
    run: async (ds, ctx) => ds.metricShowOptions((await metricEntryOf(ds, ctx.ids)).id),
  }),
  ...METRIC_QUERIES,
  entry({
    id: 'metrics.query.summary',
    family: 'metrics',
    method: 'metricQuery',
    // the page picks the metric (its show options: the summary's quantiles are read), then queries it
    builders: [
      ...METRIC_CATALOG,
      'summaryQuantilesQuery',
      ...METRIC_QUERY.filter((b) => b !== 'seriesServicesQuery'),
    ],
    spacing: 'dense',
    window: true,
    run: async (ds, ctx) => {
      const summary = (await ds.metricCatalog()).entries.find((e) => e.type === 'summary');
      if (summary === undefined)
        throw new OtelHtmlError('usage', { message: 'no summary metric in the report' });
      await ds.metricShowOptions(summary.id);
      return ds.metricQuery({
        entry: summary,
        query: { ...metricQueryOf(ctx.ids), metric: summary.name, show: 'q0.5' },
        window: windowOf(ctx),
        maxPoints: 300,
        exemplars: true,
      });
    },
  }),
  entry({
    id: 'metrics.query.residual.long',
    family: 'metrics',
    method: 'metricQuery',
    builders: [...METRIC_CATALOG, ...METRIC_QUERY, 'idTableSeriesQuery', 'idTableStatement'],
    spacing: 'sparse',
    window: true,
    run: async (ds, ctx) =>
      ds.metricQuery({
        entry: await metricEntryOf(ds, ctx.ids),
        query: metricQueryOf(ctx.ids, 'Len(resource.attributes["service.name"]) > 1'),
        window: windowOf(ctx),
        maxPoints: 300,
        exemplars: true,
      }),
  }),
  entry({
    id: 'metrics.runQuery',
    family: 'metrics',
    method: 'metricRunQuery',
    builders: [...METRIC_CATALOG, 'metricCellsQuery', 'runsQuery', 'seriesQuery'],
    spacing: 'dense',
    window: true,
    run: async (ds, ctx) =>
      ds.metricRunQuery({
        entry: await metricEntryOf(ds, ctx.ids),
        query: metricQueryOf(ctx.ids),
        window: windowOf(ctx),
        runBy: 'resource.attributes["run.id"]',
        failedWhen: null,
      }),
  }),
  entry({
    id: 'metrics.runQuery.failed',
    family: 'metrics',
    method: 'metricRunQuery',
    builders: [...METRIC_CATALOG, 'metricCellsQuery', 'runsQuery', 'seriesIdsQuery', 'seriesQuery'],
    spacing: 'dense',
    window: true,
    run: async (ds, ctx) =>
      ds.metricRunQuery({
        entry: await metricEntryOf(ds, ctx.ids),
        query: metricQueryOf(ctx.ids),
        window: windowOf(ctx),
        runBy: 'resource.attributes["run.id"]',
        failedWhen: `resource.attributes["service.name"] == "${ctx.ids.service}"`,
      }),
  }),
  point({
    id: 'metrics.forResources',
    family: 'metrics',
    method: 'metricsForResources',
    builders: ['metricDefsQuery', 'metricIdentitiesQuery', 'metricSparkQuery'],
    run: async (ds) => ds.metricsForResources((await ds.metricCatalog()).resources),
  }),
  point({
    id: 'metrics.points',
    family: 'metrics',
    method: 'metricPoints',
    builders: ['pointsTimelineQuery'],
    run: (ds) => ds.metricPoints(),
  }),
] as const satisfies readonly CatalogueEntry[];

/** The size of a scaling report the `needed` function of a declaration is asked about. */
interface ShapeSize {
  outside: number;
  inside: number;
  rowGroups: number;
}

export interface Declared {
  /** The class measured on each axis; null: the axis does not apply (no window on the entry). */
  class: Record<Axis, CostClass | null>;
  /** Why a `scan` on this axis is right (§3.4's "scan allowed"), in a sentence. */
  allowed?: Partial<Record<Axis, string>>;
  /** Row groups that hold rows the request must read; default: every row group of the selected partitions. */
  needed?: (shape: ShapeSize) => number;
  /** The id of the same request without its condition; what `matched` is measured against. */
  scanOf?: string;
}

/** A service condition selects one of the two services of every selected partition: half of the groups. */
const ONE_SERVICE = (s: ShapeSize): number => (s.inside * s.rowGroups) / 2;
/** A statistics-key condition (`run.id`) selects the one partition that holds the key. */
const ONE_PARTITION = (s: ShapeSize): number => s.rowGroups;
/** A trace id, a log ref: the rows of one trace sit in one row group. */
const ONE_GROUP = (): number => 1;

/** The sentences of `Declared.allowed`: why a `scan` is right (§3.4), or left to the baseline of the first PR. */
const SHORT_WINDOW =
  'a short window is bounded, so an aggregate reads its rows in full; §3.4 allows scan on density and window';
const ATTRIBUTE_AGGREGATE =
  'an aggregate over an attribute, a text or distinct traces reads the rows it filters; §3.4 allows scan and the README documents it';
const ROWS_PAGE =
  'a rows page sorts the rows of its window; §3.4 leaves rows pages to the baseline, no worse than today';
const PERCENTILE_SHORT =
  'percentileOf reads every span of the service and resource; §3.4 leaves it as it is on a short report';
const TRACE_LIST_SCAN =
  'a trace list under a short window or an attribute condition reads the spans of the traces it matches; §3.4 allows scan';
const BY_ID_BASELINE =
  "the rows around a log are read from its partition's logs file, which grows with the density; §3.4 leaves the other reads by id to the baseline";

type Row = [CostClass, CostClass, CostClass | null];
const decl = ([retention, density, window]: Row, rest: Omit<Declared, 'class'> = {}): Declared => ({
  class: { retention, density, window },
  ...rest,
});

/** One line per `CATALOGUE` id: the class measured on each axis today (the baseline), and why a `scan` is right. */
export const DECLARED: Record<string, Declared> = {
  'spans.total.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.total.long': decl(['scan', 'scan', 'scan']),
  'spans.buckets.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.buckets.long': decl(['scan', 'scan', 'scan']),
  'spans.timeline.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.timeline.long': decl(['scan', 'scan', 'scan']),
  'spans.facets.core.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.facets.core.long': decl(['scan', 'scan', 'scan']),
  'spans.facets.attr.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
  }),
  'spans.facets.attr.long': decl(['scan', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
  }),
  'spans.groups.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.groups.long': decl(['scan', 'scan', 'scan']),
  'spans.durations.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.durations.long': decl(['scan', 'scan', 'scan']),
  'spans.services.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.services.long': decl(['scan', 'scan', 'scan']),
  'spans.total.sortkey.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
    needed: ONE_SERVICE,
    scanOf: 'spans.total.short',
  }),
  'spans.total.sortkey.long': decl(['scan', 'scan', 'scan'], {
    needed: ONE_SERVICE,
    scanOf: 'spans.total.long',
  }),
  'spans.total.statkey.short': decl(['fixed', 'matched', 'fixed'], {
    needed: ONE_PARTITION,
    scanOf: 'spans.total.short',
  }),
  'spans.total.statkey.long': decl(['fixed', 'matched', 'fixed'], {
    needed: ONE_PARTITION,
    scanOf: 'spans.total.long',
  }),
  'spans.total.attr.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.short',
  }),
  'spans.total.attr.long': decl(['scan', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.long',
  }),
  'spans.total.text.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.short',
  }),
  'spans.total.text.long': decl(['scan', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.long',
  }),
  'spans.total.residual.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.short',
  }),
  'spans.total.residual.long': decl(['scan', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.long',
  }),
  'spans.total.traces.long': decl(['scan', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.long',
  }),
  'spans.rows.short': decl(['scan', 'scan', 'scan'], { allowed: { density: ROWS_PAGE, window: ROWS_PAGE } }),
  'spans.rows.long': decl(['scan', 'scan', 'scan'], { allowed: { density: ROWS_PAGE, window: ROWS_PAGE } }),
  'spans.rows.all': decl(['scan', 'scan', null], { allowed: { retention: ROWS_PAGE, density: ROWS_PAGE } }),
  'percentile.short': decl(['scan', 'scan', null], {
    allowed: { retention: PERCENTILE_SHORT, density: PERCENTILE_SHORT },
  }),
  'percentile.long': decl(['scan', 'scan', null]),
  'traces.list.all': decl(['scan', 'scan', null]),
  'traces.list.all.long': decl(['scan', 'scan', null]),
  'traces.list.short': decl(['scan', 'scan', 'scan'], {
    allowed: { density: TRACE_LIST_SCAN, window: TRACE_LIST_SCAN },
  }),
  'traces.list.long': decl(['scan', 'scan', 'scan']),
  'traces.list.statkey.long': decl(['scan', 'matched', 'scan'], {
    needed: ONE_PARTITION,
    scanOf: 'traces.list.long',
  }),
  'traces.list.attr.long': decl(['scan', 'scan', 'scan'], {
    allowed: { density: TRACE_LIST_SCAN, window: TRACE_LIST_SCAN },
    scanOf: 'traces.list.long',
  }),
  'trace.get': decl(['scan', 'scan', null], { needed: ONE_GROUP }),
  'trace.share': decl(['scan', 'scan', null], { needed: ONE_GROUP }),
  'trace.has': decl(['scan', 'scan', null], { needed: ONE_GROUP }),
  'trace.logs': decl(['scan', 'scan', null], { needed: ONE_GROUP }),
  'log.get': decl(['fixed', 'matched', null], { needed: ONE_GROUP }),
  'log.surrounding': decl(['scan', 'scan', null], {
    allowed: { density: BY_ID_BASELINE },
    needed: ONE_GROUP,
  }),
  'logs.timeline.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'logs.timeline.long': decl(['fixed', 'scan', 'scan']),
  'logs.facets.core.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'logs.facets.core.long': decl(['fixed', 'scan', 'scan']),
  'logs.facets.attr.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
  }),
  'logs.facets.attr.long': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
  }),
  'logs.rows.short': decl(['fixed', 'scan', 'scan'], { allowed: { density: ROWS_PAGE, window: ROWS_PAGE } }),
  'logs.rows.long': decl(['fixed', 'scan', 'scan'], { allowed: { density: ROWS_PAGE, window: ROWS_PAGE } }),
  'logs.traces.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ROWS_PAGE, window: ROWS_PAGE },
  }),
  'logs.traces.long': decl(['fixed', 'scan', 'scan'], { allowed: { density: ROWS_PAGE, window: ROWS_PAGE } }),
  'logs.timeline.statkey.short': decl(['fixed', 'matched', 'fixed'], {
    needed: ONE_PARTITION,
    scanOf: 'logs.timeline.short',
  }),
  'logs.timeline.statkey.long': decl(['fixed', 'matched', 'fixed'], {
    needed: ONE_PARTITION,
    scanOf: 'logs.timeline.long',
  }),
  'logs.timeline.text.long': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'logs.timeline.long',
  }),
  'resourceValues.all': decl(['scan', 'scan', null]),
  patterns: decl(['scan', 'fixed', null]),
  'metrics.catalog': decl(['scan', 'fixed', null]),
  'metrics.showOptions': decl(['fixed', 'fixed', null]),
  'metrics.query.short': decl(['fixed', 'fixed', 'scan']),
  'metrics.query.long': decl(['fixed', 'fixed', 'scan']),
  'metrics.query.summary': decl(['scan', 'fixed', 'scan']),
  'metrics.query.residual.long': decl(['fixed', 'fixed', 'scan']),
  'metrics.runQuery': decl(['scan', 'fixed', 'scan']),
  'metrics.runQuery.failed': decl(['scan', 'fixed', 'scan']),
  'metrics.forResources': decl(['fixed', 'fixed', null]),
  'metrics.points': decl(['scan', 'fixed', null]),
};

export interface DebtLine {
  id: string;
  axis: Axis;
  /** The open issue that describes the debt. */
  issue: number;
  /** The PR of the plan table that removes the line. */
  pr: number;
  /** The class the entry must reach for the line to go. */
  target: CostClass;
  /** True: the harness measures the `scan` today; false: owed, but measured only once the harness has the shape. */
  measured: boolean;
}

const owed = (
  issue: number,
  pr: number,
  axis: Axis,
  target: CostClass,
  measured: boolean,
  ids: readonly string[],
): DebtLine[] => ids.map((id) => ({ id, axis, issue, pr, target, measured }));

/**
 * `scan`s that §3.4 does not allow, each owed to an issue and a PR of the plan; the list only shrinks. Grouped by
 * cause: #271 (a spans file wholly before the window is opened, long-window aggregates scan raw files, a read by
 * trace id has no time bound; PR 4 and PR 6), #281 (small files read serially; PR 3), #282 (resourceValues, the
 * unconditioned trace list; PR 4), #272 (statistics lost in a merge) and #283 (compaction), the last two not yet
 * measured.
 */
export const KNOWN_DEBT: readonly DebtLine[] = [
  ...owed(271, 4, 'density', 'matched', true, ['trace.get', 'trace.share', 'trace.has', 'trace.logs']),
  ...owed(271, 6, 'density', 'fixed', true, [
    'spans.total.long',
    'spans.buckets.long',
    'spans.timeline.long',
    'spans.facets.core.long',
    'spans.groups.long',
    'spans.durations.long',
    'spans.services.long',
    'spans.total.sortkey.long',
    'percentile.long',
    'logs.timeline.long',
    'logs.facets.core.long',
  ]),
  ...owed(271, 6, 'density', 'files', true, ['traces.list.long']),
  ...owed(271, 6, 'retention', 'fixed', true, [
    'spans.total.short',
    'spans.total.long',
    'spans.buckets.short',
    'spans.buckets.long',
    'spans.timeline.short',
    'spans.timeline.long',
    'spans.facets.core.short',
    'spans.facets.core.long',
    'spans.facets.attr.short',
    'spans.facets.attr.long',
    'spans.groups.short',
    'spans.groups.long',
    'spans.durations.short',
    'spans.durations.long',
    'spans.services.short',
    'spans.services.long',
    'spans.total.sortkey.short',
    'spans.total.sortkey.long',
    'spans.total.attr.short',
    'spans.total.attr.long',
    'spans.total.text.short',
    'spans.total.text.long',
    'spans.total.residual.short',
    'spans.total.residual.long',
    'spans.total.traces.long',
    'spans.rows.short',
    'spans.rows.long',
  ]),
  ...owed(271, 6, 'retention', 'files', true, [
    'percentile.long',
    'traces.list.short',
    'traces.list.long',
    'traces.list.attr.long',
  ]),
  ...owed(271, 6, 'window', 'files', true, [
    'spans.total.long',
    'spans.buckets.long',
    'spans.timeline.long',
    'spans.facets.core.long',
    'spans.groups.long',
    'spans.durations.long',
    'spans.services.long',
    'spans.total.sortkey.long',
    'traces.list.long',
    'logs.timeline.long',
    'logs.facets.core.long',
  ]),
  ...owed(281, 3, 'retention', 'files', true, [
    'traces.list.statkey.long',
    'trace.get',
    'trace.share',
    'trace.has',
    'trace.logs',
    'log.surrounding',
    'patterns',
    'metrics.catalog',
    'metrics.points',
  ]),
  // Metrics with a window are `fixed` on retention in the end (§3.4): the small-file part goes with #281 (PR 3); the
  // partitions the window cannot hold are pruned by the end-time and manifest-range pruning of #271 (PR 6).
  ...owed(271, 6, 'retention', 'fixed', true, [
    'metrics.query.summary',
    'metrics.runQuery',
    'metrics.runQuery.failed',
  ]),
  ...owed(281, 3, 'window', 'files', true, [
    'traces.list.statkey.long',
    'metrics.query.short',
    'metrics.query.long',
    'metrics.query.summary',
    'metrics.query.residual.long',
    'metrics.runQuery',
    'metrics.runQuery.failed',
  ]),
  ...owed(282, 4, 'density', 'files', true, ['traces.list.all', 'traces.list.all.long']),
  ...owed(282, 4, 'density', 'fixed', true, ['resourceValues.all']),
  ...owed(282, 4, 'retention', 'files', true, [
    'traces.list.all',
    'traces.list.all.long',
    'resourceValues.all',
  ]),
  ...owed(272, 4, 'retention', 'fixed', false, [
    'spans.total.statkey.short',
    'spans.total.statkey.long',
    'logs.timeline.statkey.short',
    'logs.timeline.statkey.long',
  ]),
  ...owed(272, 4, 'retention', 'files', false, ['traces.list.statkey.long']),
  ...owed(283, 7, 'retention', 'fixed', false, ['spans.total.short', 'spans.total.long']),
];
