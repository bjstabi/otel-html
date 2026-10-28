import type { METRIC_DISPLAYS, METRIC_SCALES } from '../../query/metric-query.js';
import { formatBytes, formatDuration } from '../../semconv/formatters.js';
import type { MetricQueryResult, SeriesPoints } from '../data/metric-query.js';
import type { TimeWindow } from '../data/span-query.js';
import { type ColorAssigner, OTHER_INDEX } from '../theme/palette.js';
import type { ChartProps } from './chart.js';

export type MetricChartOptionResult = ChartProps['option'];
export type MetricSize = 'S' | 'M' | 'L';

/** Card heights in px. */
export const METRIC_CHART_HEIGHT: Readonly<Record<MetricSize, number>> = { S: 140, M: 220, L: 320 };

export interface MetricChartInput {
  results: readonly MetricQueryResult[];
  display: (typeof METRIC_DISPLAYS)[number];
  scale: (typeof METRIC_SCALES)[number];
  unit: string;
  colors: ColorAssigner;
  marker: number | null;
  highlightTrace: string | null;
  exemplars: boolean;
  size: MetricSize;
  /** The x range; defaults to the extent of the data. Series only cover the buckets that hold data. */
  window?: TimeWindow | null;
}

/** Canvas cannot read `var(--token)`, so colours resolve against the live theme; an unset token falls back. */
const FALLBACKS: Readonly<Record<string, string>> = {
  '--oh-accent': '#0f766e',
  '--oh-ink': '#16181d',
  '--oh-muted': '#6b6f78',
  '--oh-surface': '#ffffff',
  '--oh-hairline': '#e4e4de',
};
const GREY = '#6b6f78';

function token(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === '' ? (FALLBACKS[name] ?? GREY) : v;
}

function seriesToken(index: number): string {
  return index >= OTHER_INDEX ? '--oh-series-other' : `--oh-series-${index + 1}`;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

function plain(n: number): string {
  return String(Number(n.toPrecision(3)));
}

/** A value in its OTel unit: durations and bytes use the shared formatters, counts and ratios stay plain. */
export function formatMetricValue(unit: string, v: number): string {
  switch (unit) {
    case 's':
      return formatDuration(v * 1e9);
    case 'ms':
      return formatDuration(v * 1e6);
    case 'us':
      return formatDuration(v * 1e3);
    case 'ns':
      return formatDuration(v);
    case 'By':
      return formatBytes(v);
    case '1':
    case '':
      return plain(v);
    default:
      // Annotation units such as `{request}` are counts: the braces are not shown.
      return unit.startsWith('{') ? plain(v) : `${plain(v)} ${unit}`;
  }
}

function relSeconds(ns: number): string {
  return `${Number((ns / 1e9).toFixed(1))}s`;
}

interface TipParam {
  seriesName?: string;
  seriesType?: string;
  marker?: string;
  value?: unknown;
  data?: unknown;
}

/**
 * One tooltip line. ECharts sets the formatter's output as innerHTML, so every data-derived part (series name, trace
 * id, and the value, which carries the metric's unit verbatim) is escaped; only ECharts' own marker HTML is not.
 */
function tipLine(p: TipParam, unit: string): string {
  const v = Array.isArray(p.value) ? p.value : [];
  const last = v[v.length - 1];
  const num = escapeHtml(typeof last === 'number' ? formatMetricValue(unit, last) : '–');
  const name = escapeHtml(p.seriesName ?? '');
  const data = p.data as { traceId?: unknown } | undefined;
  if (p.seriesType === 'scatter' && typeof data?.traceId === 'string')
    return `${p.marker ?? ''}exemplar ${escapeHtml(data.traceId.slice(0, 8))}: ${num}`;
  return `${p.marker ?? ''}${name}: ${num}`;
}

function lineColor(s: SeriesPoints, colors: ColorAssigner): string {
  return token(seriesToken(colors.colorFor(s.resourceService ?? s.label)));
}

function logSafe(scale: 'linear' | 'log', v: number | null): number | null {
  return scale === 'log' && v !== null && v <= 0 ? null : v;
}

const GRID = { left: 56, right: 12, bottom: 24 } as const;
/** Diameter in px of the dot drawn for a point with no neighbour to join (wider than the 2px line). */
const ISOLATED_DOT_PX = 6;

type LinePoint = (number | null)[];

/**
 * A line joins a point only to non-null neighbours, so a point between two gaps (or a gap and the series end) would
 * draw nothing: it gets a dot. Every other point stays a plain `[time, value]`.
 */
function withIsolatedDots(
  data: readonly LinePoint[],
): (LinePoint | { value: LinePoint; symbol: string; symbolSize: number })[] {
  const has = (i: number): boolean => data[i]?.[1] != null;
  return data.map((p, i) =>
    has(i) && !has(i - 1) && !has(i + 1) ? { value: p, symbol: 'circle', symbolSize: ISOLATED_DOT_PX } : p,
  );
}

/** Pure ECharts option for a metric card. Hostile strings only ever reach the canvas or escaped tooltip HTML. */
export function buildMetricChartOption(input: MetricChartInput): MetricChartOptionResult {
  const { results, display, scale, unit, colors } = input;
  const all = results.flatMap((r) => r.series);
  const muted = token('--oh-muted');
  const accent = token('--oh-accent');
  const surface = token('--oh-surface');
  const base = {
    animation: false,
    grid: { ...GRID, top: all.length > 1 ? 28 : 12, containLabel: false },
    legend: { show: all.length > 1, top: 0, type: 'scroll' as const, data: all.map((s) => s.label) },
  };

  if (display === 'heatmap' || display === 'distribution') {
    return categoryOption(input, base, { accent, surface });
  }

  const times = all.flatMap((s) => s.points.map((p) => p[0]));
  const win = input.window ?? null;
  const widthNs = results[0]?.widthNs ?? 0;
  const xMin = win?.start ?? (times.length === 0 ? 0 : Math.min(...times));
  const xMax = win?.end ?? (times.length === 0 ? 1 : Math.max(...times) + widthNs);

  const lines = all.map((s, i) => {
    const color = lineColor(s, colors);
    const data = s.points.map((p) => [p[0], logSafe(scale, p[1])]);
    const common = { name: s.label, data, itemStyle: { color } };
    const markLine =
      i === 0 && input.marker !== null
        ? {
            silent: true,
            symbol: 'none',
            label: { show: false },
            lineStyle: { color: accent, type: 'dashed' as const, width: 1 },
            data: [{ xAxis: input.marker }],
          }
        : undefined;
    const mark = markLine === undefined ? {} : { markLine };
    if (display === 'bars') return { ...common, ...mark, type: 'bar' as const, barMaxWidth: 12 };
    return {
      ...common,
      ...mark,
      data: withIsolatedDots(data),
      type: 'line' as const,
      // Only the dots of isolated points are drawn (per item); the line itself has no symbols, and none react to the
      // pointer, so a click on the plot is a click on a bucket or an exemplar ring.
      showSymbol: true,
      symbol: 'none',
      silent: true,
      connectNulls: false,
      lineStyle: { width: 2, color },
      ...(display === 'area' ? { stack: 'total', areaStyle: { color, opacity: 0.25 } } : {}),
    };
  });

  const scatter = input.exemplars ? exemplarSeries(input, accent, surface) : [];

  return {
    ...base,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', label: { show: false } },
      formatter: (params: TipParam | TipParam[]) =>
        (Array.isArray(params) ? params : [params]).map((p) => tipLine(p, unit)).join('<br/>'),
    },
    xAxis: {
      type: 'value',
      min: xMin,
      max: xMax,
      axisLabel: { formatter: relSeconds, hideOverlap: true },
    },
    yAxis: {
      type: scale === 'log' ? 'log' : 'value',
      axisLabel: { color: muted, formatter: (v: number) => formatMetricValue(unit, v) },
    },
    series: [...lines, ...scatter],
  };
}

function exemplarSeries(input: MetricChartInput, accent: string, surface: string): object[] {
  const { colors, scale } = input;
  const byKey = new Map(input.results.flatMap((r) => r.series.map((s) => [s.key, s] as const)));
  const data = input.results
    .flatMap((r) => r.exemplars)
    // An exemplar without a trace id has nothing to open.
    .filter((e) => e.traceId !== null && logSafe(scale, e.value) !== null)
    .map((e) => {
      const s = byKey.get(e.seriesKey);
      const hit = e.traceId === input.highlightTrace;
      return {
        value: [e.time, e.value],
        traceId: e.traceId,
        spanId: e.spanId,
        symbolSize: hit ? 12 : 9,
        itemStyle: {
          color: surface,
          borderColor: hit ? accent : s === undefined ? GREY : lineColor(s, colors),
          borderWidth: hit ? 3 : 2,
        },
      };
    });
  return data.length === 0 ? [] : [{ name: 'exemplars', type: 'scatter', z: 5, data }];
}

/** The heatmap's x categories: `count` buckets of `width` ns from `t0`. The card maps a category index back to time with it. */
export function heatAxis(results: readonly MetricQueryResult[]): {
  t0: number;
  width: number;
  count: number;
} {
  const cells = results.find((r) => r.heat !== null)?.heat?.cells ?? [];
  const width = results[0]?.widthNs ?? 1;
  const t0 = cells.length === 0 ? 0 : Math.min(...cells.map((x) => x[0]));
  const t1 = cells.length === 0 ? 0 : Math.max(...cells.map((x) => x[0]));
  return { t0, width, count: Math.round((t1 - t0) / width) + 1 };
}

function categoryOption(
  input: MetricChartInput,
  base: object,
  c: { accent: string; surface: string },
): MetricChartOptionResult {
  const { display, unit, results } = input;
  const edge = (b: number): string => formatMetricValue(unit, b);
  if (display === 'distribution') {
    const d = results.find((r) => r.distribution !== null)?.distribution ?? null;
    const bounds = d?.bounds ?? [];
    const labels = (d?.counts ?? []).map((_, i) =>
      i < bounds.length ? `≤ ${edge(bounds[i] ?? 0)}` : `> ${edge(bounds[bounds.length - 1] ?? 0)}`,
    );
    return {
      ...base,
      legend: { show: false },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross', label: { show: false } } },
      xAxis: { type: 'category', data: labels, axisLabel: { hideOverlap: true } },
      yAxis: { type: input.scale === 'log' ? 'log' : 'value' },
      series: [
        {
          type: 'bar',
          name: 'count',
          data: (d?.counts ?? []).map((n) => logSafe(input.scale, n)),
          itemStyle: { color: token('--oh-series-1') },
        },
      ],
    };
  }
  const h = results.find((r) => r.heat !== null)?.heat ?? null;
  const cells = h?.cells ?? [];
  const { t0, width, count } = heatAxis(results);
  const xs = Array.from({ length: count }, (_, i) => t0 + i * width);
  const bounds = h?.bounds ?? [];
  const ys = [...bounds.map((b) => `≤ ${edge(b)}`), `> ${edge(bounds[bounds.length - 1] ?? 0)}`];
  const max = Math.max(1, ...cells.map((x) => x[2]));
  return {
    ...base,
    legend: { show: false },
    tooltip: { trigger: 'item' },
    xAxis: { type: 'category', data: xs.map(relSeconds), axisLabel: { hideOverlap: true } },
    yAxis: { type: 'category', data: ys },
    visualMap: {
      show: false,
      min: 0,
      max,
      inRange: { color: [c.surface, c.accent] },
    },
    series: [
      {
        type: 'heatmap',
        name: 'count',
        data: cells.map((x) => [Math.round((x[0] - t0) / width), x[1], x[2]]),
      },
    ],
  };
}
