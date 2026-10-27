import type { EChartsOption } from 'echarts';
import { severityKey } from '../../semconv/severity.js';
import { bar, type FacetViewContext, pie, toplist, treemap } from '../components/facet-views.js';
import { SEVERITY_SERIES } from '../components/histogram-card.js';
import type { LogQueryResult } from '../data/log-query.js';
import type { PageView } from '../state/page-options.js';

export type LogChartView = Exclude<PageView<'logs'>, 'list' | 'table'>;

export interface LogViewContext extends FacetViewContext {
  /** Most points the scatter draws (the report's `viewer.listCap`). */
  listCap: number;
}

const seconds = (ns: number): string => `${(ns / 1e9).toFixed(ns % 1e9 === 0 ? 0 : 1)}s`;

/** Stacked log counts per severity band over the result's buckets, in the severity colours (fatal on top). */
export function timeseries(result: LogQueryResult): EChartsOption {
  const b = result.buckets;
  const series = SEVERITY_SERIES.series.map((s) => ({
    name: s.label,
    type: 'line' as const,
    stack: 'severity',
    areaStyle: { opacity: 0.35 },
    showSymbol: false,
    itemStyle: { color: s.color },
    lineStyle: { color: s.color, type: s.hatch === true ? ('dashed' as const) : ('solid' as const) },
    data: Array.from({ length: b.length }, (_, i) => b.counts(s.key)[i] ?? 0),
  }));
  return {
    animation: false,
    grid: { left: 52, right: 12, top: 28, bottom: 28 },
    legend: { top: 0, data: SEVERITY_SERIES.series.map((s) => s.label) },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: Array.from({ length: b.length }, (_, i) => seconds(b.startNs + i * b.widthNs)),
      boundaryGap: false,
    },
    yAxis: { type: 'value', minInterval: 1 },
    // ECharts stacks the first series at the bottom; the legend keeps the most severe first.
    series: [...series].reverse(),
  };
}

/**
 * Severity number against log time for the returned rows, one series per band. Logs mode only: the explorer shows a
 * note in the other modes.
 */
export function scatter(result: LogQueryResult, ctx: LogViewContext): EChartsOption {
  const rows = result.mode === 'logs' ? result.rows.slice(0, ctx.listCap) : [];
  const series = SEVERITY_SERIES.series.map((s) => ({
    name: s.label,
    type: 'scatter' as const,
    // Error-like bands get a distinct symbol, so the band is not told by colour alone.
    symbol: s.hatch === true ? 'diamond' : 'circle',
    symbolSize: s.hatch === true ? 9 : 6,
    itemStyle: { color: s.color },
    data: rows
      .filter((r) => severityKey(r.log.severityNumber) === s.key)
      .map((r): [number, number] => [r.time, r.log.severityNumber]),
  }));
  return {
    animation: false,
    grid: { left: 52, right: 12, top: 28, bottom: 28 },
    legend: { top: 0 },
    tooltip: { trigger: 'item' },
    xAxis: { type: 'value', scale: true, axisLabel: { formatter: (v: number) => seconds(v) } },
    yAxis: { type: 'value', min: 0, max: 24, interval: 4, name: 'Severity' },
    series,
  };
}

export const LOG_VIEW_BUILDERS: Record<
  LogChartView,
  (result: LogQueryResult, ctx: LogViewContext) => EChartsOption
> = {
  timeseries,
  toplist,
  bar,
  treemap,
  pie,
  scatter,
};
