import { OtelHtmlError } from '../../model/errors.js';
import { parseTraceId } from '../../model/ids.js';
import type { MetricQuery } from '../../query/metric-query.js';
import type { DataSource } from './data-source.js';
import { parseLogRef } from './log-query.js';
import {
  CORE_LOG_FACET_KEYS,
  CORE_SPAN_FACET_KEYS,
  type LogNeed,
  type LogQuery,
  type SpanNeed,
  type SpanQuery,
} from './results.js';
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

const CORE_SPAN_KEYS = CORE_SPAN_FACET_KEYS;
const CORE_LOG_KEYS = CORE_LOG_FACET_KEYS;
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
  /** The builders under a long window (the router sends the need to the measures relation), where they differ. */
  long?: readonly string[];
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
        builders: v === LONG || v === ALL_LONG ? (s.long ?? s.builders) : s.builders,
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
  /** The builders under a long window (the router sends the need to the measures relation), where they differ. */
  long?: readonly string[];
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
        builders: v === LONG || v === ALL_LONG ? (s.long ?? s.builders) : s.builders,
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
  span('spans.total', ['total'], ['spanCountQuery'], { long: ['rollupTotalQuery'] }),
  {
    ...span('spans.buckets', ['buckets'], ['timelineQuery'], { long: ['rollupTimelineQuery'] }),
    family: 'time buckets',
  },
  {
    ...span('spans.timeline', ['timeline'], ['timelineQuery'], { long: ['rollupTimelineQuery'] }),
    family: 'time buckets',
  },
  {
    ...span('spans.facets.core', ['facets'], ['coreFacetsQuery'], {
      over: { facetKeys: CORE_SPAN_KEYS },
      long: ['rollupFacetsQuery'],
    }),
    family: 'top values',
  },
  {
    ...span('spans.facets.attr', ['facets'], ['coreFacetsQuery', 'attributeFacetsQuery'], {
      long: ['rollupFacetsQuery', 'attributeFacetsQuery'],
    }),
    family: 'top values',
  },
  {
    ...span('spans.groups', ['groups'], ['groupStatsQuery'], {
      over: { measureBy: 'service.name' },
      long: ['rollupGroupsQuery'],
    }),
    family: 'group statistics',
  },
  {
    ...span('spans.durations', ['durations'], ['durationSummaryQuery', 'durationBinsQuery'], {
      long: ['rollupDurationsQuery', 'rollupDurationBinsQuery'],
    }),
    family: 'duration distribution',
  },
];

const CONDITIONS: readonly [string, (ids: ScalingIds) => Condition][] = [
  ['sortkey', SORT_KEY],
  ['statkey', STAT_KEY],
  ['attr', ATTR],
  ['text', TEXT],
];
/** Under a long window a condition on a dimension is answered from the rollups; any other (and a text) reads the raw files in their shape. */
const RAW_BRANCH = ['durationBucketsQuery', 'rollupTotalQuery'] as const;
const SPAN_CONDITIONS: SpanSpec[] = [
  ...CONDITIONS.map(([c, when]) =>
    span(`spans.total.${c}`, ['total'], ['spanCountQuery'], {
      when,
      long: c === 'attr' || c === 'text' ? [...RAW_BRANCH] : ['rollupTotalQuery'],
    }),
  ),
  span(
    'spans.total.residual',
    ['total'],
    ['spanCountQuery', 'spanRowsQuery', 'idTableStatement', 'idTableRowsQuery'],
    {
      when: RESIDUAL,
      long: ['spanRowsQuery', 'idTableStatement', 'idTableRowsQuery', ...RAW_BRANCH],
    },
  ),
  span('spans.total.traces', ['total'], ['spanCountQuery'], {
    over: { mode: 'traces' },
    long: ['allTraceCountQuery'],
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

/** The trace list of a condition under a long window: the partitions of the traces that start in it, then their spans. */
const WINDOW_TRACES = ['windowTracePartitionsQuery', 'windowTraceRowsQuery'] as const;

const TRACE_LIST: SpanSpec[] = [
  {
    ...span('traces.list', ['rows'], ['allTraceRowsQuery'], { over: { mode: 'traces' } }),
    family: 'trace list',
    variants: [ALL, ALL_LONG],
  },
  {
    ...span('traces.list', ['rows'], ['traceRowsQuery'], {
      over: { mode: 'traces' },
      long: ['allTraceRowsQuery'],
    }),
    family: 'trace list',
    variants: [SHORT, LONG],
  },
  {
    ...span('traces.list.statkey', ['rows'], ['traceRowsQuery'], {
      over: { mode: 'traces' },
      long: WINDOW_TRACES,
      when: STAT_KEY,
    }),
    family: 'trace list',
    variants: [LONG],
  },
  {
    ...span('traces.list.attr', ['rows'], ['traceRowsQuery'], {
      over: { mode: 'traces' },
      when: ATTR,
      long: WINDOW_TRACES,
    }),
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
  log('logs.timeline', 'time buckets', ['timeline'], ['logTimelineQuery'], { long: ['rollupTimelineQuery'] }),
  log('logs.facets.core', 'top values', ['facets'], ['coreFacetsQuery'], {
    over: { facetKeys: CORE_LOG_KEYS },
    long: ['rollupFacetsQuery'],
  }),
  log('logs.facets.attr', 'top values', ['facets'], ['coreFacetsQuery', 'attributeFacetsQuery'], {
    long: ['rollupFacetsQuery', 'attributeFacetsQuery'],
  }),
  log('logs.rows', 'rows page', ['rows'], ['logRowsQuery']),
  log('logs.traces', 'trace list', ['rows', 'total'], ['logTracesQuery', 'logCountQuery'], {
    over: { mode: 'traces', sort: { column: 'first', dir: 'asc' } },
  }),
  log('logs.total', 'count', ['total'], ['logCountQuery'], { long: ['rollupTotalQuery'] }),
  log('logs.total.traces', 'count', ['total'], ['logCountQuery'], {
    over: { mode: 'traces', sort: { column: 'first', dir: 'asc' } },
    variants: [LONG],
  }),
  log('logs.timeline.statkey', 'time buckets', ['timeline'], ['logTimelineQuery'], {
    when: STAT_KEY,
    long: ['rollupTimelineQuery'],
  }),
  log('logs.timeline.text', 'time buckets', ['timeline'], ['logTimelineQuery'], {
    when: TEXT,
    variants: [LONG],
    long: ['rollupTimelineQuery'],
  }),
];

function windowOf(ctx: CatalogueContext): TimeWindow {
  if (ctx.window === null)
    throw new OtelHtmlError('usage', { message: 'this catalogue entry carries a window' });
  return ctx.window;
}

const entry = <M extends keyof DataSource>(e: Entry<M>): Entry<M> => e;

/** An entry for a request with no window: `window: false`, on the dense report unless it says otherwise. */
function point<M extends keyof DataSource>(
  e: Omit<CatalogueEntry, 'spacing' | 'window' | 'method'> & { method: M; spacing?: 'dense' | 'sparse' },
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
    builders:
      v === LONG ? ['rollupGroupsQuery', 'rollupTimelineQuery'] : ['servicesQuery', 'serviceBucketsQuery'],
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
    builders: v === LONG ? ['rollupPercentileQuery'] : ['percentileQuery'],
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
  // no window on a report whose range is long (the sparse one): the rollups answer; a short range reads the files (spec §6.3)
  point({
    id: 'resourceValues.all',
    family: 'distinct values',
    method: 'resourceValues',
    builders: ['rollupResourceValuesQuery'],
    spacing: 'sparse',
    run: (ds) => ds.resourceValues('service.name', { window: null }),
  }),
  ...WINDOWED.map(
    (v): Entry<'resourceValues'> => ({
      id: `resourceValues.${v.suffix}`,
      family: 'distinct values',
      method: 'resourceValues',
      builders: v === LONG ? ['rollupResourceValuesQuery'] : ['resourceValuesQuery'],
      spacing: v.spacing,
      window: true,
      run: (ds, ctx) => ds.resourceValues('service.name', { window: ctx.window }),
    }),
  ),
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
  /**
   * The raw-path reference `matched` is measured against: normally the same request without its condition. When that
   * request is itself `fixed` or `files` (so its growth is no bound), the conditioned entry that still scans.
   */
  scanOf?: string;
  /**
   * For an entry that reads traces or patterns files (and, from format 5, rollup files). Measured at the densest step
   * with the small-file limit at 0, so every file is read by range: the serial requests to the small files are at most
   * `REQUESTS_PER_OPEN` per file plus `perRowGroup` per row group of those files. It keeps a report whose traces files
   * pass the limit from reading them without bound.
   */
  aboveThreshold?: { perRowGroup: number };
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
const BASELINE: Record<string, Declared> = {
  'spans.total.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.total.long': decl(['fixed', 'fixed', 'files']),
  'spans.buckets.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.buckets.long': decl(['fixed', 'fixed', 'files']),
  'spans.timeline.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.timeline.long': decl(['fixed', 'fixed', 'files']),
  'spans.facets.core.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.facets.core.long': decl(['fixed', 'fixed', 'files']),
  'spans.facets.attr.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
  }),
  'spans.facets.attr.long': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
  }),
  'spans.groups.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.groups.long': decl(['fixed', 'fixed', 'files']),
  'spans.durations.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.durations.long': decl(['fixed', 'fixed', 'files']),
  'spans.services.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'spans.services.long': decl(['fixed', 'fixed', 'files']),
  'spans.total.sortkey.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
    needed: ONE_SERVICE,
    scanOf: 'spans.total.short',
  }),
  'spans.total.sortkey.long': decl(['fixed', 'fixed', 'files']),
  'spans.total.statkey.short': decl(['fixed', 'matched', 'fixed'], {
    needed: ONE_PARTITION,
    scanOf: 'spans.total.short',
  }),
  // window `fixed`, not the row's `files`: the statistics keep one rollup file whatever the window holds
  'spans.total.statkey.long': decl(['fixed', 'fixed', 'fixed']),
  'spans.total.attr.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.short',
  }),
  'spans.total.attr.long': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.long',
  }),
  'spans.total.text.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.short',
  }),
  'spans.total.text.long': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.long',
  }),
  'spans.total.residual.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.short',
  }),
  'spans.total.residual.long': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'spans.total.long',
  }),
  'spans.total.traces.long': decl(['files', 'files', 'files']),
  'spans.rows.short': decl(['fixed', 'scan', 'scan'], { allowed: { density: ROWS_PAGE, window: ROWS_PAGE } }),
  'spans.rows.long': decl(['fixed', 'scan', 'scan'], { allowed: { density: ROWS_PAGE, window: ROWS_PAGE } }),
  'spans.rows.all': decl(['scan', 'scan', null], { allowed: { retention: ROWS_PAGE, density: ROWS_PAGE } }),
  'percentile.short': decl(['scan', 'scan', null], {
    allowed: { retention: PERCENTILE_SHORT, density: PERCENTILE_SHORT },
  }),
  'percentile.long': decl(['files', 'fixed', null]),
  'traces.list.all': decl(['files', 'files', null]),
  'traces.list.all.long': decl(['files', 'files', null]),
  'traces.list.short': decl(['files', 'scan', 'scan'], {
    allowed: { density: TRACE_LIST_SCAN, window: TRACE_LIST_SCAN },
  }),
  'traces.list.long': decl(['files', 'files', 'files']),
  'traces.list.statkey.long': decl(['files', 'matched', 'files'], {
    needed: ONE_PARTITION,
    scanOf: 'traces.list.attr.long',
  }),
  'traces.list.attr.long': decl(['files', 'scan', 'scan'], {
    allowed: { density: TRACE_LIST_SCAN, window: TRACE_LIST_SCAN },
    scanOf: 'traces.list.long',
  }),
  'trace.get': decl(['files', 'scan', null], { needed: ONE_GROUP }),
  'trace.share': decl(['files', 'scan', null], { needed: ONE_GROUP }),
  'trace.has': decl(['files', 'files', null], { needed: ONE_GROUP }),
  'trace.logs': decl(['files', 'files', null], { needed: ONE_GROUP }),
  'log.get': decl(['fixed', 'files', null], { needed: ONE_GROUP }),
  'log.surrounding': decl(['files', 'files', null], {
    allowed: { density: BY_ID_BASELINE },
    needed: ONE_GROUP,
  }),
  'logs.timeline.short': decl(['fixed', 'files', 'files'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'logs.timeline.long': decl(['fixed', 'fixed', 'files']),
  'logs.facets.core.short': decl(['fixed', 'files', 'files'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'logs.facets.core.long': decl(['fixed', 'fixed', 'files']),
  'logs.facets.attr.short': decl(['fixed', 'files', 'files'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
  }),
  'logs.facets.attr.long': decl(['fixed', 'files', 'files'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
  }),
  'logs.rows.short': decl(['fixed', 'files', 'files'], {
    allowed: { density: ROWS_PAGE, window: ROWS_PAGE },
  }),
  'logs.rows.long': decl(['fixed', 'files', 'files'], { allowed: { density: ROWS_PAGE, window: ROWS_PAGE } }),
  'logs.traces.short': decl(['fixed', 'files', 'files'], {
    allowed: { density: ROWS_PAGE, window: ROWS_PAGE },
  }),
  'logs.traces.long': decl(['fixed', 'files', 'files'], {
    allowed: { density: ROWS_PAGE, window: ROWS_PAGE },
  }),
  'logs.total.short': decl(['fixed', 'files', 'files']),
  'logs.total.long': decl(['fixed', 'fixed', 'files']),
  'logs.total.traces.long': decl(['fixed', 'files', 'files']),
  'logs.timeline.statkey.short': decl(['fixed', 'files', 'fixed'], {
    needed: ONE_PARTITION,
    scanOf: 'logs.timeline.short',
  }),
  'logs.timeline.statkey.long': decl(['fixed', 'fixed', 'fixed']),
  'logs.timeline.text.long': decl(['fixed', 'files', 'files'], {
    allowed: { density: ATTRIBUTE_AGGREGATE, window: ATTRIBUTE_AGGREGATE },
    scanOf: 'logs.timeline.long',
  }),
  'resourceValues.all': decl(['files', 'fixed', null]),
  'resourceValues.short': decl(['fixed', 'scan', 'scan'], {
    allowed: { density: SHORT_WINDOW, window: SHORT_WINDOW },
  }),
  'resourceValues.long': decl(['fixed', 'fixed', 'files']),
  patterns: decl(['files', 'fixed', null]),
  'metrics.catalog': decl(['files', 'fixed', null]),
  'metrics.showOptions': decl(['fixed', 'fixed', null]),
  'metrics.query.short': decl(['fixed', 'fixed', 'files']),
  'metrics.query.long': decl(['fixed', 'fixed', 'files']),
  'metrics.query.summary': decl(['files', 'fixed', 'files']),
  'metrics.query.residual.long': decl(['fixed', 'fixed', 'files']),
  'metrics.runQuery': decl(['files', 'fixed', 'files']),
  'metrics.runQuery.failed': decl(['files', 'fixed', 'files']),
  'metrics.forResources': decl(['fixed', 'fixed', null]),
  'metrics.points': decl(['files', 'fixed', null]),
};

/** The builders whose statements read a traces or patterns file. */
const SMALL_TABLE_BUILDERS: ReadonlySet<string> = new Set([
  'traceRowsQuery',
  'allTraceRowsQuery',
  'allTraceCountQuery',
  'windowTracePartitionsQuery',
  'windowTraceRowsQuery',
  'tracePartitionsQuery',
  'traceSummaryQuery',
  'patternsQuery',
]);

/** The entries that read traces or patterns files, which `Declared.aboveThreshold` bounds. */
export const SMALL_TABLE_ENTRIES: readonly CatalogueEntry[] = CATALOGUE.filter((e) =>
  e.builders.some((b) => SMALL_TABLE_BUILDERS.has(b)),
);

/** `BASELINE` with `aboveThreshold` (2 requests per row group) on every entry of `SMALL_TABLE_ENTRIES`. */
export const DECLARED: Record<string, Declared> = Object.fromEntries(
  Object.entries(BASELINE).map(([id, declared]) => [
    id,
    SMALL_TABLE_ENTRIES.some((e) => e.id === id)
      ? { ...declared, aboveThreshold: { perRowGroup: 2 } }
      : declared,
  ]),
);

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
 * cause: #271 (paid by PR 6: the aggregates, the percentile, the trace list and `resourceValues` under a long window; the
 * metrics entries measure `fixed` on retention by the end-time and manifest-range pruning), #281 (small files read
 * serially; PR 3, done), #282 (paid by PR 6: the rollup route answers `resourceValues` without a window), #283
 * (compaction), not yet measured, and
 * #291 (opening a trace reads the spans files of its partitions whole; no PR of the plan fixes it, so PR 9 carries it).
 */
export const KNOWN_DEBT: readonly DebtLine[] = [
  ...owed(291, 9, 'density', 'matched', true, ['trace.get', 'trace.share']),
  ...owed(283, 7, 'retention', 'fixed', false, ['spans.total.short', 'spans.total.long']),
];
