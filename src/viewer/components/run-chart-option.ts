import type { RunControls } from '../../dashboards/schema.js';
import type { RunInfo, RunLine, RunQueryResult } from '../data/metric-run-query.js';
import { type ColorAssigner, OTHER_INDEX, STATUS } from '../theme/palette.js';
import type { ChartProps } from './chart.js';
import {
  escapeHtml,
  formatMetricValue,
  mergeEchartsOption,
  seriesToken,
  token,
} from './metric-chart-option.js';
import { formatTick, niceAxis, runDateTime, shortLabel } from './run-chart-format.js';
import { plotRects } from './run-chart-layout.js';

/** A zoom as run times, so switching spacing keeps the same runs in view. RelNanos, both inclusive. */
export interface RunZoom {
  start: number;
  end: number;
}

export interface RunChartInput {
  result: RunQueryResult;
  controls: RunControls;
  /** Line keys. */
  hidden: ReadonlySet<string>;
  zoom: RunZoom | null;
  /** The chart's own size in px: without any legend, which lives outside ECharts. */
  width: number;
  height: number;
  colors: ColorAssigner;
  epochUnixNano: string;
  selectedRun: string | null;
  /** Whether clicking a dot does something, which shows as the pointer cursor. */
  pickable: boolean;
  echarts: Record<string, unknown> | null;
}

interface PointMeta {
  line: string;
  label: string;
  value: number;
  failed: boolean;
  run: RunInfo;
  runIndex: number;
}

const SINGLE_PLOT_TICKS = 5;
const SMALL_CHART_TICKS = 3;
const NS_PER_MS = 1e6;
const DOT_PX = 5;
const FAILED_DOT_PX = 9;
const TOOLTIP_CSS = 'max-width:280px;white-space:normal;overflow-wrap:anywhere';
/** Sits in the 40px `plotRects` reserves below the plots, lined up with the first plot's left edge. */
const SLIDER = { height: 20, bottom: 8, right: 16 };
/** A title's offset above its plot, within the room `plotRects` leaves for it. */
const TITLE_ABOVE_PX = 16;

/**
 * A run's x on the time axis: whole ms since the report's epoch, not since 1970, because ECharts reads the axis as ms
 * and `zoomFromEvent` has no epoch. Labels add the epoch back through `runDateTime`.
 */
const timeX = (relNanos: number): number => Math.round(relNanos / NS_PER_MS);

const visibleLines = (result: RunQueryResult, hidden: ReadonlySet<string>): RunLine[] =>
  result.lines.filter((l) => !hidden.has(l.key));

/** The series in one plot must share a unit (spec §7), so mixed units split however the toggle is set. */
const mixedUnits = (lines: readonly RunLine[]): boolean => new Set(lines.map((l) => l.unit)).size > 1;

/** The runs a zoom holds, which can be none. */
export function runsInView(result: RunQueryResult, zoom: RunZoom | null): RunInfo[] {
  if (zoom === null) return result.runs;
  return result.runs.filter((r) => r.time >= zoom.start && r.time <= zoom.end);
}

/** One y axis per plot, from the visible lines and the runs in view; a zoom with no run in view uses every run. */
export function runYAxes(
  i: Pick<RunChartInput, 'result' | 'controls' | 'hidden' | 'zoom'>,
  split: boolean,
): { min: 0; max: number; interval: number }[] {
  const inView = runsInView(i.result, i.zoom);
  const held = new Set(inView.length === 0 ? i.result.runs : inView);
  const lines = visibleLines(i.result, i.hidden);
  const maxOf = (ls: readonly RunLine[]): number => {
    let max = 0;
    for (const l of ls) {
      for (const [n, p] of l.points.entries()) {
        const run = i.result.runs[n];
        if (p !== null && run !== undefined && held.has(run)) max = Math.max(max, p.value);
      }
    }
    return max;
  };
  const unit = lines[0]?.unit ?? '';
  if (!(split || mixedUnits(lines)) || lines.length <= 1) {
    return [niceAxis(maxOf(lines), unit, SINGLE_PLOT_TICKS)];
  }
  return lines.map((l) => niceAxis(maxOf([l]), l.unit, SMALL_CHART_TICKS));
}

/**
 * The zoom for a `datazoom` event's axis values (run indexes, or `timeX` values), or null when every run is in view.
 * On real time a window edge can sit between runs, and is kept there so the slider isn't moved under the pointer.
 */
export function zoomFromEvent(
  result: RunQueryResult,
  evenSpacing: boolean,
  startValue: number,
  endValue: number,
): RunZoom | null {
  const { runs } = result;
  if (runs.length === 0) return null;
  if (evenSpacing) {
    const at = (v: number): number => Math.min(runs.length - 1, Math.max(0, Math.round(v)));
    const first = at(startValue);
    const last = at(endValue);
    if (first === 0 && last === runs.length - 1) return null;
    return { start: runs[first]?.time ?? 0, end: runs[last]?.time ?? 0 };
  }
  if (runs.every((r) => timeX(r.time) >= startValue && timeX(r.time) <= endValue)) return null;
  // An edge on a run's x is that run's exact time: ms to nanos doesn't round-trip below a millisecond.
  const relNanos = (v: number): number => runs.find((r) => timeX(r.time) === v)?.time ?? v * NS_PER_MS;
  return { start: relNanos(startValue), end: relNanos(endValue) };
}

/** Plot `i`'s guide: a vertical line at axis value `x`, or none. Also for `setOption` by id, for a hovered run. */
export function guideSeries(i: number, x: number | null): object {
  return {
    id: `guide${i}`,
    type: 'line',
    xAxisIndex: i,
    yAxisIndex: i,
    data: [],
    silent: true,
    showSymbol: false,
    tooltip: { show: false },
    markLine: {
      silent: true,
      symbol: 'none',
      animation: false,
      label: { show: false },
      lineStyle: { color: token('--oh-muted'), type: 'dashed', width: 1 },
      // A single plot's hover dims other series, and the guide must stay readable through it.
      blur: { lineStyle: { opacity: 1 } },
      data: x === null ? [] : [{ xAxis: x }],
    },
  };
}

/** A distinct dash per line past the seventh, counted over all lines so that hiding one doesn't change another's. */
function dashOf(n: number): number[] {
  return [3 + 3 * (n % 6), 3 + 2 * Math.floor(n / 6)];
}

/** Each line's color and dash, assigned over all lines in order so that neither depends on what is hidden. */
function lineStyles(
  result: RunQueryResult,
  colors: ColorAssigner,
): Map<string, { color: string; type?: number[] }> {
  const styles = new Map<string, { color: string; type?: number[] }>();
  let others = 0;
  for (const l of result.lines) {
    const index = colors.colorFor(l.label);
    const color = token(seriesToken(index));
    styles.set(l.key, index >= OTHER_INDEX ? { color, type: dashOf(others++) } : { color });
  }
  return styles;
}

/** Pure ECharts option for a run chart: one grid per plot, one slider over all of them. */
export function buildRunChartOption(i: RunChartInput): { option: ChartProps['option']; splitFits: boolean } {
  const { result, controls, epochUnixNano } = i;
  const { runs } = result;
  const even = controls.evenSpacing;
  const lines = visibleLines(result, i.hidden);
  const mixed = mixedUnits(lines);
  const { rects, splitFits } = plotRects({
    width: i.width,
    height: i.height,
    plots: lines.length,
    split: controls.split || mixed,
    slider: controls.slider,
    forceSplit: mixed,
  });
  const split = rects.length > 1;
  const styles = lineStyles(result, i.colors);
  const muted = token('--oh-muted');
  const hairline = token('--oh-hairline');
  const xOf = (r: RunInfo, n: number): number => (even ? n : timeX(r.time));

  const label = (relNanos: number | undefined): string => {
    if (relNanos === undefined) return '';
    const d = runDateTime(epochUnixNano, relNanos);
    return `${d.date}\n${d.time}`;
  };
  // Category values are the run's index as a string; ECharts' own label index counts from the zoom's start.
  const xFormatter = even
    ? (v: string | number): string => label(runs[Number(v)]?.time)
    : (v: string | number): string => label(Number(v) * NS_PER_MS);
  const first = runs[0];
  const last = runs[runs.length - 1];
  // One run leaves the extent empty, so ECharts centers it on an extent of its own.
  const timeExtent =
    first !== undefined && last !== undefined && timeX(first.time) !== timeX(last.time)
      ? { min: timeX(first.time), max: timeX(last.time) }
      : {};

  const xAxis = rects.map((rect, n) => ({
    gridIndex: n,
    ...(even
      ? {
          type: 'category' as const,
          data: runs.map((_, r) => String(r)),
          boundaryGap: false,
          splitLine: { show: true, interval: 0, lineStyle: { color: hairline } },
        }
      : { type: 'time' as const, ...timeExtent, splitLine: { show: false } }),
    axisTick: { show: false },
    axisLabel: {
      show: rect.xLabels,
      color: muted,
      hideOverlap: true,
      alignMaxLabel: 'right' as const,
      formatter: xFormatter,
    },
  }));

  const yAxis = runYAxes(i, split).map((axis, n) => {
    const unit = (split ? lines[n] : lines[0])?.unit ?? '';
    return {
      type: 'value' as const,
      gridIndex: n,
      ...axis,
      axisLabel: { color: muted, formatter: (v: number) => formatTick(v, unit) },
      splitLine: { lineStyle: { color: hairline } },
    };
  });

  const series = lines.map((l, n) => {
    const style = styles.get(l.key);
    const plot = split ? n : 0;
    return {
      id: `line:${l.key}`,
      name: l.label,
      type: 'line' as const,
      xAxisIndex: plot,
      yAxisIndex: plot,
      connectNulls: true,
      // ECharts otherwise drops the dots it thinks are crowded, and a dot is what opens the tooltip.
      showSymbol: true,
      showAllSymbol: true,
      symbol: 'circle',
      symbolSize: DOT_PX,
      cursor: i.pickable ? 'pointer' : 'default',
      itemStyle: { color: style?.color },
      lineStyle: { width: 1.5, ...style },
      ...(split ? {} : { emphasis: { focus: 'series' as const } }),
      data: l.points.flatMap((p, r) => {
        const run = runs[r];
        if (p === null || run === undefined) return [];
        const meta: PointMeta = {
          line: l.key,
          label: l.label,
          value: p.value,
          failed: p.failed,
          run,
          runIndex: r,
        };
        return [
          {
            value: [xOf(run, r), p.value],
            meta,
            ...(p.failed
              ? { symbol: 'diamond', symbolSize: FAILED_DOT_PX, itemStyle: { color: STATUS.critical } }
              : {}),
          },
        ];
      }),
    };
  });

  const selected = runs.findIndex((r) => r.id === i.selectedRun);
  const selectedRun = runs[selected];
  const guideX = selectedRun === undefined ? null : xOf(selectedRun, selected);

  const axes = rects.map((_, n) => n);
  const inView = runsInView(result, i.zoom);
  const firstInView = inView[0];
  const lastInView = inView[inView.length - 1];
  // Category axes can only show runs, so a zoom holding none shows them all.
  const window =
    i.zoom === null
      ? {}
      : !even
        ? { startValue: timeX(i.zoom.start), endValue: timeX(i.zoom.end) }
        : firstInView === undefined || lastInView === undefined
          ? {}
          : { startValue: runs.indexOf(firstInView), endValue: runs.indexOf(lastInView) };
  const dataZoom = [
    {
      type: 'inside' as const,
      xAxisIndex: axes,
      filterMode: 'none' as const,
      zoomOnMouseWheel: 'ctrl' as const,
      moveOnMouseWheel: false,
      moveOnMouseMove: false,
      ...window,
    },
    ...(controls.slider
      ? [
          {
            type: 'slider' as const,
            xAxisIndex: axes,
            filterMode: 'none' as const,
            left: rects[0]?.left,
            ...SLIDER,
            // Its default labels would show the time axis's raw values, which are relative to the report.
            showDetail: false,
            showDataShadow: false,
            ...window,
          },
        ]
      : []),
  ];

  const tooltip = {
    trigger: 'item' as const,
    confine: true,
    extraCssText: TOOLTIP_CSS,
    formatter: (p: { marker?: string; data?: { meta?: PointMeta } }): string => {
      const meta = p.data?.meta;
      if (meta === undefined) return '';
      const unit = result.lines.find((l) => l.key === meta.line)?.unit ?? '';
      const d = runDateTime(epochUnixNano, meta.run.time);
      const commit = meta.run.revision === null ? '' : ` · ${escapeHtml(meta.run.revision.slice(0, 7))}`;
      return [
        `${p.marker ?? ''}${escapeHtml(meta.label)}`,
        `${escapeHtml(formatMetricValue(unit, meta.value))}${meta.failed ? ' · failed' : ''}`,
        `${escapeHtml(d.date)} ${escapeHtml(d.time)}${commit}`,
      ].join('<br/>');
    },
  };

  const option = {
    animation: false,
    grid: rects.map((r) => ({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      containLabel: false,
    })),
    title: split
      ? rects.map((r, n) => ({
          text: shortLabel(lines[n]?.label ?? ''),
          left: r.left,
          top: r.top - TITLE_ABOVE_PX,
          textStyle: {
            fontSize: 11,
            fontWeight: 'normal' as const,
            color: muted,
            width: r.width,
            overflow: 'truncate' as const,
          },
        }))
      : [],
    xAxis,
    yAxis,
    dataZoom,
    tooltip,
    series: lines.length === 0 ? [] : [...series, ...rects.map((_, n) => guideSeries(n, guideX))],
  };
  return {
    option: (i.echarts === null ? option : mergeEchartsOption(option, i.echarts)) as ChartProps['option'],
    splitFits,
  };
}
