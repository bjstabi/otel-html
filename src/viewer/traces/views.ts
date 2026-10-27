import type { EChartsOption } from 'echarts';
import { formatDuration } from '../../semconv/formatters.js';
import type { DurationBin } from '../components/facet-panel.js';
import { bar, type FacetViewContext, pie, toplist, treemap } from '../components/facet-views.js';
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

export interface ViewContext extends FacetViewContext {
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

const seconds = (ns: number): string => `${(ns / 1e9).toFixed(ns % 1e9 === 0 ? 0 : 1)}s`;

function timeAxis(result: SpanQueryResult): string[] {
  const b = result.buckets;
  return Array.from({ length: b.length }, (_, i) => seconds(b.startNs + i * b.widthNs));
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

export const VIEW_BUILDERS: Record<ChartView, (result: SpanQueryResult, ctx: ViewContext) => EChartsOption> =
  {
    timeseries,
    toplist,
    bar,
    pointplot,
    treemap,
    pie,
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

/**
 * Log-spaced duration bins over the durations of the returned rows (the filtered set when `total` fits the list
 * limit, the leading rows of it otherwise), `[from, to)` with contiguous edges; every row lands in exactly one bin.
 */
export function durationBins(rows: readonly { durationNs: number }[], binCount: number): DurationBin[] {
  if (rows.length === 0) return [];
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (const r of rows) {
    lo = Math.min(lo, r.durationNs);
    hi = Math.max(hi, r.durationNs);
  }
  const floor = Math.max(1, lo);
  const top = Math.max(hi, floor) + 1;
  const step = (Math.log(top) - Math.log(floor)) / binCount;
  const edges = Array.from({ length: binCount + 1 }, (_, i) => Math.exp(Math.log(floor) + step * i));
  edges[0] = Math.min(floor, lo);
  edges[binCount] = top;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    fromNs: edges[i] ?? 0,
    toNs: edges[i + 1] ?? top,
    count: 0,
  }));
  for (const r of rows) {
    const d = Math.max(r.durationNs, 1);
    const i = Math.min(binCount - 1, Math.max(0, Math.floor((Math.log(d) - Math.log(floor)) / step)));
    const bin = bins[step === 0 ? 0 : i];
    if (bin !== undefined) bin.count++;
  }
  return bins;
}
