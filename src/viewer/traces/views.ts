import type { EChartsOption } from 'echarts';
import { formatDuration } from '../../semconv/formatters.js';
import type { DurationBin } from '../components/facet-panel.js';
import { bar, type FacetViewContext, pie, toplist, treemap } from '../components/facet-views.js';
import { seconds } from '../components/histogram-card.js';
import type { SpanQueryResult, SpanRow, TraceRow } from '../data/span-query.js';
import type { ExplorerView } from '../state/explorer-view.js';
import type { PageView } from '../state/page-options.js';

export {
  DEFAULT_GROUP_KEY,
  groupSlices,
  MAX_GROUPS,
  OTHER_LABEL,
  type Slice,
} from '../components/facet-views.js';

export type ChartView = Exclude<PageView<'traces'>, 'list' | 'table'>;
export type Measure = 'requests' | 'errors' | 'latency';

// The explorer's measure is the time series' own; the facet views' duration measure is a dashboard widget's.
export interface ViewContext extends Omit<FacetViewContext, 'measure'> {
  /** What the time series plots; requests by default. */
  measure?: Measure;
}

/** Views that are drawn from a facet's top values; the others ignore the group-by key. */
export const GROUPED_VIEWS: ReadonlySet<ExplorerView> = new Set<ExplorerView>([
  'table',
  'toplist',
  'bar',
  'pie',
  'treemap',
]);

function timeAxis(result: SpanQueryResult): string[] {
  const b = result.buckets;
  return Array.from({ length: b.length }, (_, i) => seconds(b.startNs + i * b.widthNs, b.widthNs));
}

const STATUS_VARS = {
  ok: 'var(--oh-series-1)',
  error: 'var(--oh-critical)',
  unset: 'var(--oh-series-other)',
};

function latencySeries(result: SpanQueryResult): NonNullable<EChartsOption['series']> {
  const hists = result.red.histograms;
  const line = (name: string, q: number, color: string) => ({
    name,
    type: 'line' as const,
    showSymbol: false,
    itemStyle: { color },
    lineStyle: { color },
    data: hists.map((h) => (h === undefined ? null : h.quantile(q))),
  });
  return [
    line('p50', 0.5, 'var(--oh-series-1)'),
    line('p95', 0.95, 'var(--oh-series-4)'),
    line('p99', 0.99, 'var(--oh-critical)'),
  ];
}

/**
 * Time series of the filtered set. Not grouped in M1 (the data layer does not group): requests are stacked by
 * status, errors are the error bucket alone, latency is p50/p95/p99 from the per-bucket histograms.
 */
function timeseries(result: SpanQueryResult, ctx: ViewContext): EChartsOption {
  const measure = ctx.measure ?? 'requests';
  const b = result.buckets;
  const keys = measure === 'errors' ? (['error'] as const) : b.keys;
  const series: NonNullable<EChartsOption['series']> =
    measure === 'latency'
      ? latencySeries(result)
      : keys.map((k) => ({
          name: k,
          type: 'line' as const,
          stack: 'status',
          areaStyle: { opacity: 0.35 },
          showSymbol: false,
          itemStyle: { color: STATUS_VARS[k] },
          lineStyle: {
            color: STATUS_VARS[k],
            type: k === 'error' ? ('dashed' as const) : ('solid' as const),
          },
          data: Array.from({ length: b.length }, (_, i) => b.counts(k)[i] ?? 0),
        }));
  return {
    animation: false,
    grid: { left: 52, right: 12, top: 28, bottom: 28 },
    legend: { top: 0 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: timeAxis(result), boundaryGap: false },
    yAxis:
      measure === 'latency'
        ? { type: 'value', axisLabel: { formatter: (v: number) => formatDuration(v) } }
        : { type: 'value', minInterval: 1 },
    series,
  };
}

function isError(r: SpanRow | TraceRow): boolean {
  return 'span' in r ? r.span.status.code === 2 : r.errors > 0;
}

function startOf(r: SpanRow | TraceRow): number {
  return 'span' in r ? r.span.start : r.start;
}

/** Duration against start time for the returned rows; errors are a separate series with a distinct symbol. */
function pointplot(result: SpanQueryResult): EChartsOption {
  const points = (err: boolean): number[][] =>
    result.rows.filter((r) => isError(r) === err).map((r) => [startOf(r), r.durationNs]);
  return {
    animation: false,
    grid: { left: 64, right: 12, top: 28, bottom: 28 },
    legend: { top: 0 },
    tooltip: { trigger: 'item' },
    xAxis: { type: 'value', scale: true, axisLabel: { formatter: (v: number) => seconds(v) } },
    yAxis: { type: 'log', min: 1, axisLabel: { formatter: (v: number) => formatDuration(v) } },
    series: [
      {
        name: 'ok',
        type: 'scatter',
        symbol: 'circle',
        symbolSize: 6,
        itemStyle: { color: 'var(--oh-series-1)' },
        data: points(false),
      },
      {
        name: 'error',
        type: 'scatter',
        symbol: 'diamond',
        symbolSize: 9,
        itemStyle: { color: 'var(--oh-critical)' },
        data: points(true),
      },
    ],
  };
}

/** The facet views never read the time series' measure; they get only what they draw by. */
function facetView(
  view: (result: SpanQueryResult, ctx: FacetViewContext) => EChartsOption,
): (result: SpanQueryResult, ctx: ViewContext) => EChartsOption {
  return (result, ctx) => view(result, { groupBy: ctx.groupBy, colors: ctx.colors });
}

export const VIEW_BUILDERS: Record<ChartView, (result: SpanQueryResult, ctx: ViewContext) => EChartsOption> =
  {
    timeseries,
    toplist: facetView(toplist),
    bar: facetView(bar),
    pointplot,
    treemap: facetView(treemap),
    pie: facetView(pie),
  };

const VAR_RE = /^var\((--[a-z0-9-]+)\)$/;

/** Deep copy of an option with every `var(--token)` string replaced by the resolver's value (unresolved ones stay). */
export function resolveCssVars<T>(value: T, resolve: (name: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = VAR_RE.exec(v);
      const name = m?.[1];
      if (name === undefined) return v;
      const out = resolve(name);
      return out === '' ? v : out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  // The walk preserves the shape of its input; it only swaps strings for strings.
  return walk(value) as T;
}

/** Reads theme tokens from the document's computed style (the resolver `resolveCssVars` takes in the viewer). */
export function cssTokenReader(): (name: string) => string {
  const style = getComputedStyle(document.documentElement);
  return (name) => style.getPropertyValue(name).trim();
}

/**
 * Log-spaced duration bin edges (`binCount + 1`, ascending) over the rows' durations. A `range` pins the axis
 * instead: `range.lo` and `range.hi` become the first and last edge exactly, whatever the rows hold. A `lo` below 1
 * ns spaces the interior edges from 1 ns (the log needs a positive floor) but the first edge stays `lo`; a `hi` at or
 * below the floor spaces the interior as if it were the floor plus 1 ns, with the interior clamped into the pinned
 * ends (degenerate ranges give zero-width bins). With a range the axis exists without rows; no rows and no range give
 * no edges.
 */
export function durationAxis(
  rows: readonly { durationNs: number }[],
  binCount: number,
  range?: { lo?: number; hi?: number },
): number[] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (const r of rows) {
    lo = Math.min(lo, r.durationNs);
    hi = Math.max(hi, r.durationNs);
  }
  const given = range?.lo !== undefined || range?.hi !== undefined;
  if (rows.length === 0 && !given) return [];
  let first = range?.lo ?? (rows.length === 0 ? 1 : lo);
  // A `hi` below the rows' minimum drags the unpinned first edge down with it.
  if (range?.lo === undefined && range?.hi !== undefined) first = Math.min(first, range.hi);
  const floor = Math.max(1, first);
  const top = range?.hi !== undefined ? (range.hi > floor ? range.hi : floor + 1) : Math.max(hi, floor) + 1;
  // Without a range the top edge sits one past the largest duration so that duration is inside its `[from, to)` bin.
  const step = (Math.log(top) - Math.log(floor)) / binCount;
  const edges = Array.from({ length: binCount + 1 }, (_, i) => Math.exp(Math.log(floor) + step * i));
  const start = range?.lo ?? Math.min(floor, first);
  const end = range?.hi ?? top;
  for (let i = 1; i < binCount; i++) edges[i] = Math.max(start, Math.min(edges[i] ?? start, end));
  edges[0] = start;
  edges[binCount] = end;
  // Whole nanoseconds: the edges become `>=`/`<=` tokens, and rounding keeps them non-decreasing.
  return edges.map(Math.round);
}

/** Counts rows into the `[from, to)` bins between `edges`; a row below the first edge counts in the first bin, one at or above the last in the last. */
export function binsOnAxis(rows: readonly { durationNs: number }[], edges: readonly number[]): DurationBin[] {
  const n = edges.length - 1;
  if (n < 1) return [];
  const bins = Array.from({ length: n }, (_, i) => ({
    fromNs: edges[i] ?? 0,
    toNs: edges[i + 1] ?? 0,
    count: 0,
  }));
  for (const r of rows) {
    let i = 0;
    while (i < n - 1 && r.durationNs >= (edges[i + 1] ?? Number.POSITIVE_INFINITY)) i++;
    const bin = bins[i];
    if (bin !== undefined) bin.count++;
  }
  return bins;
}

/**
 * Log-spaced duration bins over the durations of the returned rows (the filtered set when `total` fits the list
 * limit, the leading rows of it otherwise), `[from, to)` with contiguous edges; every row lands in exactly one bin.
 */
export function durationBins(rows: readonly { durationNs: number }[], binCount: number): DurationBin[] {
  return binsOnAxis(rows, durationAxis(rows, binCount));
}
