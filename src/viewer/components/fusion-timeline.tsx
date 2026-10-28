import { type JSX, type KeyboardEvent, type PointerEvent, useMemo, useRef, useState } from 'react';
import type { TimeWindow } from '../data/span-query.js';
import { Chart } from './chart.js';
import {
  type BucketView,
  brushToWindow,
  coarsenBuckets,
  GRID,
  type HistogramSeriesSet,
  histogramBars,
  seconds,
  useThemeTick,
} from './histogram-card.js';

/** One lane of the timeline: a bucketed signal with its label, total and a note ("no spans", "all resources"). */
export interface TimelineLane {
  label: string;
  total: number;
  buckets: BucketView<string>;
  series: HistogramSeriesSet<string>;
  note: string | null;
}

/** Most columns before the shared axis doubles its column width; lanes then fit the same cap as the histogram. */
const MAX_AXIS_COLUMNS = 4096;
/** Pixels the pointer may move between press and release and still count as a click. */
const CLICK_SLOP_PX = 3;
/** Space under the last lane for the time labels, and between lanes. */
const AXIS_PX = 20;
const LANE_GAP_PX = 6;

/**
 * Every lane on one column grid. The lanes' bucket widths are `1 ms * 2^k` and their starts are multiples of their
 * width, so the widest lane's width divides evenly into the others and re-binning is exact. Columns cover `window`;
 * data outside it is dropped.
 */
export function alignLanes(
  lanes: readonly { buckets: BucketView<string> }[],
  window: TimeWindow,
): { startNs: number; widthNs: number; length: number; lanes: BucketView<string>[] } {
  let widthNs = Math.max(1_000_000, ...lanes.map((l) => l.buckets.widthNs));
  const columns = (w: number): number =>
    Math.max(1, Math.ceil((window.end - Math.floor(window.start / w) * w) / w));
  while (columns(widthNs) > MAX_AXIS_COLUMNS) widthNs *= 2;
  const startNs = Math.floor(window.start / widthNs) * widthNs;
  const length = columns(widthNs);
  const aligned = lanes.map(({ buckets: b }) => {
    const sums = new Map<string, number[]>();
    for (const k of b.keys) {
      const out = new Array<number>(length).fill(0);
      const src = b.counts(k);
      for (let i = 0; i < b.length; i++) {
        const n = src[i] ?? 0;
        if (n === 0) continue;
        const j = Math.floor((b.startNs + i * b.widthNs - startNs) / widthNs);
        if (j >= 0 && j < length) out[j] = (out[j] ?? 0) + n;
      }
      sums.set(k, out);
    }
    const view: BucketView<string> = {
      keys: b.keys,
      startNs,
      widthNs,
      length,
      counts: (k) => sums.get(k) ?? [],
      total: (k) => (sums.get(k) ?? []).reduce((a, n) => a + n, 0),
    };
    return view;
  });
  return { startNs, widthNs, length, lanes: aligned };
}

function buildTimelineOption(
  lanes: readonly TimelineLane[],
  views: readonly BucketView<string>[],
  height: number,
) {
  const first = views[0];
  const x =
    first === undefined
      ? []
      : Array.from({ length: first.length }, (_, i) => seconds(first.startNs + i * first.widthNs));
  const laneH = (height - AXIS_PX) / Math.max(1, lanes.length);
  const top = (i: number): number => i * laneH + LANE_GAP_PX / 2;
  return {
    animation: false,
    tooltip: { trigger: 'axis' },
    grid: lanes.map((_, i) => ({
      left: GRID.left,
      right: GRID.right,
      top: top(i),
      height: Math.max(8, laneH - LANE_GAP_PX),
      containLabel: false,
    })),
    xAxis: lanes.map((_, i) => ({
      type: 'category',
      gridIndex: i,
      data: x,
      axisTick: { show: false },
      axisLabel: { show: i === lanes.length - 1 },
    })),
    yAxis: lanes.map((_, i) => ({
      type: 'value',
      gridIndex: i,
      minInterval: 1,
      splitNumber: 1,
    })),
    series: lanes.flatMap((lane, i) => {
      const view = views[i];
      if (view === undefined) return [];
      const bars = histogramBars(view, lane.series.series, { xAxisIndex: i, yAxisIndex: i });
      return lane.series.topFirst ? bars.reverse() : bars;
    }),
  };
}

/**
 * Spans by status, logs by severity and metric points on one time axis: one chart with a grid per lane. Dragging
 * across the plot brushes a window; a click without a drag clears it.
 */
export function FusionTimeline(props: {
  lanes: readonly TimelineLane[];
  window: TimeWindow;
  brush: TimeWindow | null;
  height: number;
  onBrush(w: TimeWindow | null): void;
}): JSX.Element {
  const { lanes, window: win, brush, height, onBrush } = props;
  const themeTick = useThemeTick();
  const axis = useMemo(() => {
    const a = alignLanes(lanes, win);
    // Every lane has the same length, so one coarsening factor applies to all.
    const views = a.lanes.map((v) => coarsenBuckets(v));
    return { views, view: views[0] ?? null };
  }, [lanes, win]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeTick re-reads the CSS colour tokens
  const option = useMemo(
    () => buildTimelineOption(lanes, axis.views, height),
    [lanes, axis, height, themeTick],
  );
  const [range, setRange] = useState<{ anchor: number; cursor: number } | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number } | null>(null);

  const view = axis.view;
  const length = view?.length ?? 0;
  const last = Math.max(0, length - 1);
  const laneH = (height - AXIS_PX) / Math.max(1, lanes.length);
  const col = 100 / Math.max(1, length);

  const indexAt = (clientX: number): number => {
    const el = overlay.current;
    if (el === null || length === 0) return 0;
    const r = el.getBoundingClientRect();
    const f = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return Math.min(last, Math.max(0, Math.floor(f * length)));
  };

  /** The brushed columns as a window of whole nanoseconds inside the page window. */
  const commit = (r: { anchor: number; cursor: number }): void => {
    if (view === null) return;
    const w = brushToWindow(view, r.anchor, r.cursor, win.end);
    const start = Math.max(win.start, Math.ceil(w.start));
    const end = Math.min(win.end, Math.floor(w.end));
    onBrush({ start, end: Math.max(start, end) });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (length === 0) return;
    const cur = range?.cursor ?? 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cursor = Math.min(last, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
      setRange({ anchor: e.shiftKey ? (range?.anchor ?? cur) : cursor, cursor });
    } else if (e.key === 'Enter' && range !== null) {
      e.preventDefault();
      commit(range);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setRange(null);
      onBrush(null);
    }
  };

  // The brush from the page, as columns; a drag in progress takes over until it is released.
  const fromBrush =
    brush === null || view === null
      ? null
      : {
          lo: Math.max(0, Math.floor((brush.start - view.startNs) / view.widthNs)),
          hi: Math.min(last, Math.max(0, Math.ceil((brush.end - view.startNs) / view.widthNs) - 1)),
        };
  const shown =
    range === null
      ? fromBrush
      : { lo: Math.min(range.anchor, range.cursor), hi: Math.max(range.anchor, range.cursor) };

  const ariaLabel = `Timeline: ${lanes.map((l) => `${l.label} ${l.total}`).join(', ')}`;
  const plotTop = LANE_GAP_PX / 2;
  const plotBottom = AXIS_PX;

  return (
    <div className="relative" style={{ height }}>
      <Chart option={option} height={height} ariaLabel={ariaLabel} />
      {lanes.map((lane, i) => (
        <p
          key={lane.label}
          className="pointer-events-none absolute truncate rounded-sm bg-surface/80 px-1 text-xs text-ink-2"
          style={{ left: GRID.left + 4, right: GRID.right, top: i * laneH + LANE_GAP_PX / 2 + 1 }}
        >
          <span className="font-mono tabular-nums">{`${lane.label} ${lane.total}`}</span>
          {lane.note === null ? null : <span className="text-muted">{` · ${lane.note}`}</span>}
        </p>
      ))}
      {/* biome-ignore lint/a11y/useSemanticElements: a custom brush widget, not a form field group */}
      <div
        ref={overlay}
        role="group"
        aria-label="Time brush"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-operable brush (arrows, Shift, Enter, Escape)
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
          press.current = { x: e.clientX };
          e.currentTarget.setPointerCapture?.(e.pointerId);
          const i = indexAt(e.clientX);
          setRange({ anchor: i, cursor: i });
        }}
        onPointerMove={(e) => {
          if (press.current !== null)
            setRange((r) => (r === null ? r : { anchor: r.anchor, cursor: indexAt(e.clientX) }));
        }}
        onPointerUp={(e) => {
          const down = press.current;
          press.current = null;
          if (down === null || range === null) return;
          if (Math.abs(e.clientX - down.x) <= CLICK_SLOP_PX) {
            setRange(null);
            onBrush(null);
            return;
          }
          const r = { anchor: range.anchor, cursor: indexAt(e.clientX) };
          setRange(null);
          commit(r);
        }}
        className="absolute cursor-crosshair rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        style={{ left: GRID.left, right: GRID.right, top: plotTop, bottom: plotBottom }}
      >
        {shown === null ? null : (
          <div
            aria-hidden
            className="absolute inset-y-0 border-x border-ink bg-ink/10"
            style={{ left: `${shown.lo * col}%`, width: `${(shown.hi - shown.lo + 1) * col}%` }}
          />
        )}
      </div>
    </div>
  );
}
