import type { CustomSeriesRenderItem, EChartsOption } from 'echarts';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { type JSX, useCallback, useMemo, useRef, useState } from 'react';
import { anyValueToDisplay } from '../../model/anyvalue.js';
import type { RelNanos, SpanId } from '../../model/ids.js';
import { formatDuration } from '../../semconv/formatters.js';
import type { TraceDetail } from '../data/data-source.js';
import type { SpanRow } from '../data/span-query.js';
import { type ColorAssigner, OTHER_INDEX } from '../theme/palette.js';
import { useTheme } from '../theme/theme-provider.js';
import { Chart, type EChartsType } from './chart.js';
import { FIELD } from './field.js';
import { type FlameBar, type FlameColorBy, type FlameLegendEntry, layoutFlame } from './flame-layout.js';

/** Resolved colours (canvas cannot read CSS variables). `series` holds the 7 categorical colours then Other. */
export interface FlameTheme {
  ink: string;
  surface: string;
  critical: string;
  muted: string;
  hairline: string;
  accent: string;
  font: string;
  series: readonly string[];
}

export interface FlameView {
  selectedSpanId: SpanId | null;
  /** Visible window as percentages of the trace extent. */
  zoom: { start: number; end: number };
  /** Rows of depth drawn; deeper bars are clipped (the Waterfall shows every span). */
  maxRows: number;
  /**
   * Bars shorter than this (ns) are drawn merged, one path per depth row and colour, without labels. 0 draws every
   * bar on its own. Big traces need this: one chart element per bar costs about 10 ms per 1000 spans.
   */
  minBarNs?: number;
  /** The span to outline in the accent colour (the one that emitted a log), labelled when the bar is wide enough. */
  outlineSpanId?: SpanId | null;
  /** Dashed vertical lines in the accent colour, each at a time on the bars' axis. */
  markers?: readonly FlameMarker[];
}

export interface FlameMarker {
  time: RelNanos;
  label: string;
}

/** The label tail on the outlined bar. */
export const OUTLINE_TAIL = '← emitted this log';
/** Rough width per character of the 11px mono label, used only where no canvas can measure text (jsdom). */
const CHAR_PX = 6.6;

/** The shared measuring context: created on first use; null when the environment has no 2D canvas. */
let measurer: CanvasRenderingContext2D | null | undefined;

/** Width in px of `text` drawn in `font` (a CSS font string), measured on a cached canvas. */
export function labelWidth(text: string, font: string): number {
  measurer ??= document.createElement('canvas').getContext('2d');
  if (measurer === null) return text.length * CHAR_PX;
  measurer.font = font;
  return measurer.measureText(text).width;
}

/** Traces with at most this many spans always draw every bar on its own. */
export const BATCH_ABOVE_BARS = 2000;
/** Narrow means shorter than this fraction of the visible window. */
export const NARROW_FRACTION = 0.004;

export type FlameItem =
  | { kind: 'bar'; index: number }
  | { kind: 'batch'; depth: number; colorIndex: number; dimmed: boolean; error: boolean; indexes: number[] };

/** Chart items: wide bars (and the selected one) alone, the narrow rest merged by depth, colour, dimming and error. */
export function buildFlameItems(
  bars: readonly FlameBar[],
  minBarNs: number,
  selectedSpanId: SpanId | null,
  outlineSpanId: SpanId | null = null,
): FlameItem[] {
  if (minBarNs <= 0) return bars.map((_, index) => ({ kind: 'bar', index }));
  const items: FlameItem[] = [];
  const batches = new Map<string, Extract<FlameItem, { kind: 'batch' }>>();
  bars.forEach((b, index) => {
    if (b.end - b.start >= minBarNs || b.spanId === selectedSpanId || b.spanId === outlineSpanId) {
      items.push({ kind: 'bar', index });
      return;
    }
    const key = `${b.depth}|${b.colorIndex}|${b.dimmed ? 1 : 0}|${b.error ? 1 : 0}`;
    let batch = batches.get(key);
    if (batch === undefined) {
      batch = {
        kind: 'batch',
        depth: b.depth,
        colorIndex: b.colorIndex,
        dimmed: b.dimmed,
        error: b.error,
        indexes: [],
      };
      batches.set(key, batch);
      items.push(batch);
    }
    batch.indexes.push(index);
  });
  // Sorted by start so a draw can merge pixel-adjacent bars in one sweep.
  for (const item of items) {
    if (item.kind === 'batch') item.indexes.sort((a, b) => (bars[a]?.start ?? 0) - (bars[b]?.start ?? 0));
  }
  return items;
}

export const FLAME_MAX_ROWS = 200;
const ROW_PX = 18;
const GRID = { left: 8, right: 8, top: 4, bottom: 24 } as const;

function fallbackSeries(): string[] {
  return Array.from({ length: OTHER_INDEX + 1 }, () => '#9a9da5');
}

function readFlameTheme(): FlameTheme {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => {
    const x = style.getPropertyValue(name).trim();
    return x === '' ? fallback : x;
  };
  const series = fallbackSeries().map((f, i) =>
    v(i >= OTHER_INDEX ? '--oh-series-other' : `--oh-series-${i + 1}`, f),
  );
  return {
    ink: v('--oh-ink', '#16181d'),
    surface: v('--oh-surface', '#ffffff'),
    critical: v('--oh-critical', '#d03b3b'),
    muted: v('--oh-muted', '#6b6f78'),
    hairline: v('--oh-hairline', '#e4e4de'),
    accent: v('--oh-accent', '#0f766e'),
    font: v('--oh-font-mono', 'monospace'),
    series,
  };
}

/** Ink or surface, whichever reads better on `fill` (hex only; anything else keeps ink). */
export function labelColorOn(fill: string, theme: Pick<FlameTheme, 'ink' | 'surface'>): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fill);
  if (m === null) return theme.ink;
  const lin = (h: string | undefined): number => {
    const c = Number.parseInt(h ?? '0', 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
  // Contrast against black text vs white text.
  return (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05) ? '#111111' : '#ffffff';
}

const hatchCache = new Map<string, unknown>();

/** Diagonal-stripe pattern for error bars (canvas pattern image), or undefined where canvas is unavailable. */
function hatch(color: string): unknown {
  const cached = hatchCache.get(color);
  if (cached !== undefined) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const g = canvas.getContext('2d');
  if (g === null) return undefined;
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(-2, 10);
  g.lineTo(10, -2);
  g.moveTo(-2, 2);
  g.lineTo(2, -2);
  g.moveTo(6, 10);
  g.lineTo(10, 6);
  g.stroke();
  const pattern = { image: canvas, repeat: 'repeat' };
  hatchCache.set(color, pattern);
  return pattern;
}

interface CoordSys {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isCoordSys(v: unknown): v is CoordSys {
  return (
    typeof v === 'object' &&
    v !== null &&
    'x' in v &&
    'y' in v &&
    'width' in v &&
    'height' in v &&
    typeof v.x === 'number' &&
    typeof v.y === 'number' &&
    typeof v.width === 'number' &&
    typeof v.height === 'number'
  );
}

/** Pixel rows needed for the chart body, including the time axis. */
export function flameHeight(bars: readonly FlameBar[], maxRows = FLAME_MAX_ROWS): number {
  let depth = 0;
  for (const b of bars) if (b.depth > depth) depth = b.depth;
  const rows = Math.min(depth + 1, maxRows);
  return rows * ROW_PX + GRID.top + GRID.bottom;
}

function extentOf(bars: readonly FlameBar[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const b of bars) {
    if (b.start < min) min = b.start;
    if (b.end > max) max = b.end;
  }
  return bars.length === 0 ? { min: 0, max: 1 } : { min, max: max > min ? max : min + 1 };
}

type RenderItem = CustomSeriesRenderItem;

/** `[depth, start, end, itemIndex]`; a batch spans the extent of its bars so the zoom window can skip it. */
function itemRow(item: FlameItem, bars: readonly FlameBar[], i: number): number[] {
  if (item.kind === 'bar') {
    const b = bars[item.index];
    return b === undefined ? [0, 0, 0, i] : [b.depth, b.start, b.end, i];
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const k of item.indexes) {
    const b = bars[k];
    if (b === undefined) continue;
    if (b.start < start) start = b.start;
    if (b.end > end) end = b.end;
  }
  return [item.depth, start, end, i];
}

type Coord = (v: [number, number]) => number[];

/** All narrow bars of one depth row and colour as a single path (plain rectangles, no labels). */
function renderBatch(
  item: Extract<FlameItem, { kind: 'batch' }>,
  bars: readonly FlameBar[],
  theme: FlameTheme,
  rows: number,
  cs: CoordSys,
  coord: Coord,
): ReturnType<RenderItem> {
  const rowH = cs.height / rows;
  const y = cs.y + item.depth * rowH + 1;
  const h = Math.max(1, rowH - 2);
  const x2 = cs.x + cs.width;
  let d = '';
  const flush = (a: number, b: number): void => {
    d += `M${a.toFixed(1)} ${y.toFixed(1)}h${(b - a).toFixed(1)}v${h.toFixed(1)}h${(a - b).toFixed(1)}z`;
  };
  // Level of detail: bars that touch within half a pixel are one rectangle.
  let run0 = Number.NaN;
  let run1 = Number.NaN;
  for (const k of item.indexes) {
    const b = bars[k];
    if (b === undefined) continue;
    const sx = coord([b.start, 0])[0] ?? 0;
    const ex = coord([b.end, 0])[0] ?? 0;
    const x0 = Math.max(sx, cs.x);
    const x1 = Math.min(Math.max(ex, sx + 1), x2);
    if (x1 <= x0) continue;
    if (Number.isNaN(run0)) {
      run0 = x0;
      run1 = x1;
    } else if (x0 <= run1 + 0.5) {
      if (x1 > run1) run1 = x1;
    } else {
      flush(run0, run1);
      run0 = x0;
      run1 = x1;
    }
  }
  if (!Number.isNaN(run0)) flush(run0, run1);
  const fill = theme.series[item.colorIndex] ?? theme.series[OTHER_INDEX] ?? theme.muted;
  return {
    type: 'path',
    shape: { d },
    style: {
      fill,
      opacity: item.dimmed ? 0.22 : 1,
      ...(item.error ? { stroke: theme.critical, lineWidth: 1 } : {}),
    },
    silent: true,
  } as ReturnType<RenderItem>;
}

/**
 * The flame graph as an ECharts custom series (spike section 12): rounded bars, a `service · name` label that
 * truncates to the bar, hatch plus outline for errors, a ring on the selected bar. Labels are canvas text, never
 * HTML. The tooltip is off on purpose; the panel shows the hovered span as plain React text.
 */
export function flameOption(bars: readonly FlameBar[], theme: FlameTheme, view: FlameView): EChartsOption {
  const { min, max } = extentOf(bars);
  const rows = Math.min(bars.reduce((d, b) => Math.max(d, b.depth), 0) + 1, view.maxRows);
  // ECharts does not clip a markLine to the plot: a time outside the trace extent would draw past the axis.
  const markers = (view.markers ?? []).filter((m) => m.time >= min && m.time <= max);
  const outlineId = view.outlineSpanId ?? null;
  const items = buildFlameItems(bars, view.minBarNs ?? 0, view.selectedSpanId, outlineId);
  const renderItem: RenderItem = (params, api) => {
    const item = items[Number(api.value(3))];
    const cs: unknown = params.coordSys;
    if (item === undefined || !isCoordSys(cs)) return { type: 'group', children: [] };
    if (item.kind === 'batch') return renderBatch(item, bars, theme, rows, cs, api.coord);
    const bar = bars[item.index];
    if (bar === undefined) return { type: 'group', children: [] };
    const depth = Number(api.value(0));
    const sx = api.coord([Number(api.value(1)), 0])[0] ?? 0;
    const ex = api.coord([Number(api.value(2)), 0])[0] ?? 0;
    const rowH = cs.height / rows;
    const x0 = Math.max(sx, cs.x);
    const x1 = Math.min(Math.max(ex, sx + 1.5), cs.x + cs.width);
    if (x1 <= x0) return { type: 'group', children: [] };
    const y = cs.y + depth * rowH + 1;
    const h = Math.max(1, rowH - 2);
    const fill = theme.series[bar.colorIndex] ?? theme.series[OTHER_INDEX] ?? theme.muted;
    const opacity = bar.dimmed ? 0.22 : 1;
    const shape = { x: x0, y, width: x1 - x0, height: h, r: x1 - x0 > 8 ? 3 : 0 };
    const base = { type: 'rect', shape, style: { fill, opacity } };
    // The common bar is one flat rect: at 50k spans a group per bar would double the element count.
    const outlined = bar.spanId === outlineId;
    const plain = !bar.error && bar.spanId !== view.selectedSpanId && !outlined && x1 - x0 < 36;
    if (plain) return base as ReturnType<RenderItem>;
    const children: object[] = [base];
    if (bar.error) {
      const pattern = hatch(theme.surface);
      if (pattern !== undefined) children.push({ type: 'rect', shape, style: { fill: pattern, opacity } });
      children.push({
        type: 'rect',
        shape,
        style: { fill: 'none', stroke: theme.critical, lineWidth: 2, opacity },
      });
    }
    if (outlined) {
      children.push({
        type: 'rect',
        shape: { x: x0 - 1, y: y - 1, width: x1 - x0 + 2, height: h + 2, r: 4 },
        style: { fill: 'none', stroke: theme.accent, lineWidth: 2 },
      });
    }
    if (bar.spanId === view.selectedSpanId) {
      children.push({
        type: 'rect',
        shape: { x: x0 - 2, y: y - 2, width: x1 - x0 + 4, height: h + 4, r: 5 },
        style: { fill: 'none', stroke: theme.ink, lineWidth: 2 },
      });
    }
    if (x1 - x0 >= 36 && h >= 10) {
      const name = bar.error ? `✕ ${bar.label}` : bar.label;
      const font = `11px ${theme.font}`;
      const withTail = `${name}  ${OUTLINE_TAIL}`;
      const tailed = outlined && labelWidth(withTail, font) <= x1 - x0 - 8;
      children.push({
        type: 'text',
        style: {
          text: tailed ? withTail : name,
          x: x0 + 4,
          y: y + h / 2,
          width: x1 - x0 - 8,
          overflow: 'truncate',
          ellipsis: '…',
          verticalAlign: 'middle',
          fill: labelColorOn(fill, theme),
          font,
          opacity,
        },
        silent: true,
      });
    }
    // The group's children are plain element specs; zrender builds the shapes.
    return { type: 'group', children } as ReturnType<RenderItem>;
  };

  return {
    animation: false,
    tooltip: { show: false },
    grid: { ...GRID, containLabel: false },
    xAxis: {
      type: 'value',
      min,
      max,
      axisLabel: {
        color: theme.muted,
        fontFamily: theme.font,
        formatter: (v: number) => formatDuration(v - min),
      },
      splitLine: { lineStyle: { color: theme.hairline } },
    },
    yAxis: { type: 'value', min: 0, max: rows, inverse: true, show: false },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'weakFilter',
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
        start: view.zoom.start,
        end: view.zoom.end,
      },
    ],
    series: [
      {
        type: 'custom',
        renderItem,
        encode: { x: [1, 2], y: 0 },
        data: items.map((item, i) => itemRow(item, bars, i)),
        // Bars are clipped to the plot in renderItem (cheaper than the series-level clip at 50k).
        clip: false,
        // Silent elements are much cheaper to build; clicks and hover are hit-tested in `barAt` through the zrender layer.
        silent: true,
        // One synchronous pass: progressive chunks of a few hundred items take one frame each (seconds at 50k).
        progressive: 0,
        animation: false,
        ...(markers.length === 0
          ? {}
          : {
              markLine: {
                silent: true,
                symbol: 'none',
                animation: false,
                lineStyle: { color: theme.accent, type: 'dashed', width: 1.5 },
                label: { show: true, position: 'insideEndTop', color: theme.accent, fontFamily: theme.font },
                data: markers.map((m) => ({ xAxis: m.time, label: { formatter: m.label } })),
              },
            }),
      },
    ],
  };
}

export const MINIMAP_MAX_BARS = 4000;

/** At most `cap` bars for the overview: every error, then the longest spans (order kept). Small traces are untouched. */
export function sampleForOverview(bars: readonly FlameBar[], cap: number): readonly FlameBar[] {
  if (bars.length <= cap) return bars;
  const keep = new Set<FlameBar>();
  for (const b of bars) if (b.error && keep.size < cap / 2) keep.add(b);
  const byLength = [...bars].sort((a, b) => b.end - b.start - (a.end - a.start));
  for (const b of byLength) {
    if (keep.size >= cap) break;
    keep.add(b);
  }
  return bars.filter((b) => keep.has(b));
}

/** The whole-trace overview with a draggable window that is linked to the main chart's zoom. */
export function minimapOption(
  all: readonly FlameBar[],
  theme: FlameTheme,
  zoom: FlameView['zoom'],
): EChartsOption {
  const { min, max } = extentOf(all);
  const bars = sampleForOverview(all, MINIMAP_MAX_BARS);
  const rows = Math.min(bars.reduce((d, b) => Math.max(d, b.depth), 0) + 1, FLAME_MAX_ROWS);
  const renderItem: RenderItem = (params, api) => {
    const bar = bars[Number(api.value(3))];
    const cs: unknown = params.coordSys;
    if (bar === undefined || !isCoordSys(cs)) return { type: 'group', children: [] };
    const depth = Number(api.value(0));
    const s = api.coord([Number(api.value(1)), depth]);
    const e = api.coord([Number(api.value(2)), depth]);
    const rowH = (api.coord([Number(api.value(1)), depth + 1])[1] ?? 0) - (s[1] ?? 0);
    return {
      type: 'rect',
      shape: {
        x: s[0] ?? 0,
        y: s[1] ?? 0,
        width: Math.max(1, (e[0] ?? 0) - (s[0] ?? 0)),
        height: Math.max(1, rowH - 0.5),
      },
      style: {
        fill: bar.error ? theme.critical : (theme.series[bar.colorIndex] ?? theme.muted),
        opacity: 0.8,
      },
    } as ReturnType<RenderItem>;
  };
  return {
    animation: false,
    tooltip: { show: false },
    grid: { left: 8, right: 8, top: 4, bottom: 4 },
    xAxis: { type: 'value', min, max, show: false },
    yAxis: { type: 'value', min: 0, max: rows, inverse: true, show: false },
    dataZoom: [
      {
        type: 'slider',
        xAxisIndex: 0,
        filterMode: 'none',
        showDetail: false,
        showDataShadow: false,
        brushSelect: false,
        top: 0,
        height: 52,
        borderColor: theme.hairline,
        backgroundColor: 'transparent',
        fillerColor: `${theme.accent}33`,
        handleSize: '90%',
        start: zoom.start,
        end: zoom.end,
      },
    ],
    series: [
      {
        type: 'custom',
        renderItem,
        encode: { x: [1, 2], y: 0 },
        data: bars.map((b, i) => [b.depth, b.start, b.end, i]),
        silent: true,
        progressive: 0,
        animation: false,
      },
    ],
  };
}

function zoomRangeOf(params: unknown): { start: number; end: number } | null {
  const pick = (o: unknown): { start: number; end: number } | null => {
    if (typeof o !== 'object' || o === null) return null;
    const start = 'start' in o ? o.start : undefined;
    const end = 'end' in o ? o.end : undefined;
    return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
  };
  if (typeof params === 'object' && params !== null && 'batch' in params && Array.isArray(params.batch)) {
    return pick(params.batch[0]);
  }
  return pick(params);
}

/**
 * The bar under a point: at that depth, the narrowest bar whose extent (widened by `tolerance` so sub-pixel bars
 * stay clickable) contains `time`. Hit-testing is done here, not per element, because 50k interactive elements
 * make the chart several times slower to build.
 */
export function barAt(
  bars: readonly FlameBar[],
  time: number,
  depth: number,
  tolerance: number,
): FlameBar | null {
  let best: FlameBar | null = null;
  for (const b of bars) {
    if (b.depth !== depth || time < b.start - tolerance || time > b.end + tolerance) continue;
    if (best === null || b.end - b.start < best.end - best.start) best = b;
  }
  return best;
}

declare global {
  interface Window {
    /** Present only when the document element has a `data-perf` attribute (set by the e2e tests). */
    __OH_PERF__?: {
      flameRenderMs: number;
      flameBars: number;
      layoutMs: number;
      optionMs: number;
      renderedMs: number;
    };
  }
}

function perfEnabled(): boolean {
  return typeof document !== 'undefined' && document.documentElement.hasAttribute('data-perf');
}

const SWATCH = (i: number): string =>
  i >= OTHER_INDEX ? 'var(--oh-series-other)' : `var(--oh-series-${i + 1})`;
const ICON_BTN = 'rounded-full border border-hairline bg-surface p-1.5 hover:bg-hairline';

function hostOf(detail: TraceDetail, row: SpanRow): string {
  const v = detail.resources(row.span.resource).attributes.get('host.name');
  return v === undefined ? row.resource : anyValueToDisplay(v);
}

export interface FlameGraphProps {
  detail: TraceDetail;
  selectedSpanId: SpanId | null;
  onSelect(spanId: SpanId): void;
  colors: ColorAssigner;
  /** Outline this span in the accent colour (the span that emitted a log). */
  outlineSpanId?: SpanId | null;
  /** Dashed accent lines at times on the trace's axis. */
  markers?: readonly FlameMarker[];
  /** A small embed (the Traces widget): no minimap, no legend and no colour-by control. */
  compact?: boolean;
}

/**
 * Flame graph card: filter, errors-only, colour-by, zoom controls, minimap and the % execution-time legend.
 * `compact` leaves out the last three.
 */
export function FlameGraph(props: FlameGraphProps): JSX.Element {
  const { detail, selectedSpanId, onSelect, colors, outlineSpanId = null, markers, compact = false } = props;
  const { resolved } = useTheme();
  const [colorBy, setColorBy] = useState<FlameColorBy>('service');
  const [filter, setFilter] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [hovered, setHovered] = useState<FlameBar | null>(null);
  const main = useRef<EChartsType | null>(null);
  const mini = useRef<EChartsType | null>(null);
  const zoom = useRef({ start: 0, end: 100 });
  const started = useRef(0);
  // log2 of how far the window is zoomed in; changing it re-merges narrow bars relative to what is visible.
  const [zoomLevel, setZoomLevel] = useState(0);
  const stages = useRef({ layoutMs: 0, optionMs: 0, renderedMs: 0 });

  const { bars, legend } = useMemo(() => {
    if (perfEnabled()) started.current = performance.now();
    const laid = layoutFlame(
      detail.tree,
      { colorBy, filter, errorsOnly },
      {
        colors,
        keyOf: (row, by) => {
          switch (by) {
            case 'service':
              return row.service;
            case 'host':
              return hostOf(detail, row);
            case 'scope':
              return detail.scopes(row.span.scope).name;
            default: {
              const never: never = by;
              throw new Error(`unhandled colour-by ${String(never)}`);
            }
          }
        },
      },
    );
    if (perfEnabled()) stages.current.layoutMs = performance.now() - started.current;
    return laid;
  }, [detail, colorBy, filter, errorsOnly, colors]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resolved` re-reads the CSS tokens when light/dark changes
  const theme = useMemo(() => readFlameTheme(), [resolved]);
  const mainOption = useMemo(() => {
    const t = performance.now();
    const { min, max } = extentOf(bars);
    const minBarNs = bars.length <= BATCH_ABOVE_BARS ? 0 : ((max - min) * NARROW_FRACTION) / 2 ** zoomLevel;
    const o = flameOption(bars, theme, {
      selectedSpanId,
      zoom: zoom.current,
      maxRows: FLAME_MAX_ROWS,
      minBarNs,
      outlineSpanId,
      ...(markers === undefined ? {} : { markers }),
    });
    if (perfEnabled() && started.current !== 0) stages.current.optionMs = performance.now() - t;
    return o;
  }, [bars, theme, selectedSpanId, zoomLevel, outlineSpanId, markers]);
  const miniOption = useMemo(() => minimapOption(bars, theme, zoom.current), [bars, theme]);

  const sync = useCallback((to: 'main' | 'mini') => {
    return (params: unknown): void => {
      const r = zoomRangeOf(params);
      if (r === null) return;
      const cur = zoom.current;
      if (Math.abs(cur.start - r.start) < 1e-6 && Math.abs(cur.end - r.end) < 1e-6) return;
      zoom.current = r;
      (to === 'main' ? main : mini).current?.dispatchAction({ type: 'dataZoom', start: r.start, end: r.end });
    };
  }, []);

  const mainEvents = useMemo(
    () => ({
      rendered: (): void => {
        if (perfEnabled() && started.current !== 0 && stages.current.renderedMs === 0)
          stages.current.renderedMs = performance.now() - started.current;
      },
      datazoom: (p: unknown): void => {
        const r = zoomRangeOf(p);
        if (r !== null)
          setZoomLevel(Math.max(0, Math.round(Math.log2(100 / Math.max(0.01, r.end - r.start)))));
        sync('mini')(p);
      },
      finished: (): void => {
        if (!perfEnabled() || started.current === 0) return;
        window.__OH_PERF__ = {
          flameRenderMs: performance.now() - started.current,
          flameBars: bars.length,
          ...stages.current,
        };
        started.current = 0;
      },
    }),
    [bars, sync],
  );
  const latest = useRef({ bars, onSelect });
  latest.current = { bars, onSelect };
  const attachPointer = useCallback((chart: EChartsType | null): void => {
    main.current = chart;
    if (chart === null) return;
    const zr = chart.getZr();
    const pick = (x: number, y: number): FlameBar | null => {
      const here = chart.convertFromPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [x, y]);
      const next = chart.convertFromPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [x + 1.5, y]);
      const time = here[0];
      const depth = here[1];
      if (time === undefined || depth === undefined || next[0] === undefined) return null;
      return barAt(latest.current.bars, time, Math.floor(depth), next[0] - time);
    };
    zr.on('click', (e: { offsetX: number; offsetY: number }) => {
      const bar = pick(e.offsetX, e.offsetY);
      if (bar !== null) latest.current.onSelect(bar.spanId);
    });
    zr.on('mousemove', (e: { offsetX: number; offsetY: number }) => setHovered(pick(e.offsetX, e.offsetY)));
    zr.on('globalout', () => setHovered(null));
  }, []);

  const miniEvents = useMemo(() => ({ datazoom: sync('main') }), [sync]);

  const zoomBy = (factor: number): void => {
    const { start, end } = zoom.current;
    const mid = (start + end) / 2;
    const half = Math.min(50, Math.max(0.01, ((end - start) / 2) * factor));
    const next = { start: Math.max(0, mid - half), end: Math.min(100, mid + half) };
    zoom.current = next;
    main.current?.dispatchAction({ type: 'dataZoom', ...next });
    mini.current?.dispatchAction({ type: 'dataZoom', ...next });
  };
  const resetZoom = (): void => {
    zoom.current = { start: 0, end: 100 };
    main.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    mini.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
  };

  const maxDepth = bars.reduce((d, b) => Math.max(d, b.depth), 0);
  const clipped = maxDepth + 1 > FLAME_MAX_ROWS;
  const errorCount = bars.filter((b) => b.error).length;
  const dimmed = bars.filter((b) => b.dimmed).length;
  const outlined = outlineSpanId === null ? undefined : bars.find((b) => b.spanId === outlineSpanId);

  return (
    <div data-testid="flame-graph" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <span className="sr-only">Filter spans</span>
          <input
            type="search"
            placeholder="Filter spans"
            aria-label="Filter spans"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={`${FIELD} w-44`}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
          Errors only
        </label>
        {!compact && (
          <label className="flex items-center gap-2 text-sm text-ink-2">
            Color by
            <select
              aria-label="Color by"
              className={FIELD}
              value={colorBy}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'service' || v === 'host' || v === 'scope') setColorBy(v);
              }}
            >
              <option value="service">Service</option>
              <option value="host">Host</option>
              <option value="scope">Scope</option>
            </select>
          </label>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button type="button" className={ICON_BTN} aria-label="Zoom in" onClick={() => zoomBy(0.5)}>
            <Plus size={14} aria-hidden />
          </button>
          <button type="button" className={ICON_BTN} aria-label="Zoom out" onClick={() => zoomBy(2)}>
            <Minus size={14} aria-hidden />
          </button>
          <button type="button" className={ICON_BTN} aria-label="Reset zoom" onClick={resetZoom}>
            <RotateCcw size={14} aria-hidden />
          </button>
        </span>
      </div>
      <p className="font-mono text-xs tabular-nums text-muted">
        {bars.length} spans
        {errorCount > 0 ? ` · ${errorCount} errors (hatched, red outline, ✕)` : ''}
        {dimmed > 0 ? ` · ${bars.length - dimmed} match` : ''}
      </p>
      <div className="max-h-[420px] overflow-y-auto rounded-card border border-hairline bg-surface p-1">
        <Chart
          option={mainOption}
          height={flameHeight(bars)}
          ariaLabel={`Flame graph of ${bars.length} spans (the Waterfall and Span list tabs are keyboard accessible)`}
          onEvents={mainEvents}
          onInstance={attachPointer}
        />
      </div>
      {!compact && (
        <div className="rounded-card border border-hairline bg-surface p-1">
          <Chart
            option={miniOption}
            height={56}
            ariaLabel="Trace minimap: drag the window to zoom"
            onEvents={miniEvents}
            onInstance={(c) => {
              mini.current = c;
            }}
          />
        </div>
      )}
      {clipped && (
        <p role="note" className="text-xs text-muted">
          Showing the first <span className="font-mono tabular-nums">{FLAME_MAX_ROWS}</span> of{' '}
          <span className="font-mono tabular-nums">{maxDepth + 1}</span> depth levels. The Waterfall lists
          every span.
        </p>
      )}
      {outlined !== undefined && (
        <p data-testid="flame-outline" className="font-mono text-xs break-words text-accent">
          {outlined.label} {OUTLINE_TAIL}
        </p>
      )}
      <output aria-label="Hovered span" className="min-h-5 font-mono text-xs break-words text-ink-2">
        {hovered === null
          ? 'Hover a bar for its span; click to select it.'
          : `${hovered.label} · ${formatDuration(hovered.end - hovered.start)}${hovered.error ? ' · error' : ''}`}
      </output>
      {!compact && <FlameLegend legend={legend} colors={colors} colorBy={colorBy} />}
    </div>
  );
}

function FlameLegend(props: {
  legend: readonly FlameLegendEntry[];
  colors: ColorAssigner;
  colorBy: FlameColorBy;
}): JSX.Element {
  return (
    <section aria-label="Execution time share" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <h3 className="sr-only">Share of exclusive execution time by {props.colorBy}</h3>
      {props.legend.map((l) => (
        <span key={l.key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-2.5 rounded-sm"
            style={{ background: SWATCH(props.colors.colorFor(l.key)) }}
          />
          <span className="max-w-[16rem] truncate">{l.key}</span>
          <span className="font-mono text-xs tabular-nums text-ink-2">{(l.share * 100).toFixed(1)}%</span>
        </span>
      ))}
    </section>
  );
}
