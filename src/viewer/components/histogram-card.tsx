import { type JSX, type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { LogSeverityKey } from '../../rollups/signal-counts.js';
import type { SpanStatusKey } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import type { TimeWindow } from '../data/span-query.js';
import { useSelection } from '../state/selection-context.js';
import { Chart } from './chart.js';

/** Plot insets in px; the brush overlay uses the same values so pointer x maps onto bucket columns. */
const GRID = { left: 40, right: 8, top: 24, bottom: 24 } as const;

/**
 * Most columns the histogram draws. Rollups keep up to 4096 buckets, far more than the card is wide, and every
 * drawn bar costs layout and paint on each filter change.
 */
export const HISTOGRAM_MAX_COLUMNS = 300;

/** What the card reads from a bucket set; `TimeBuckets` and its coarsened views both satisfy it. */
export interface BucketView<K extends string> {
  readonly keys: readonly K[];
  readonly startNs: number;
  readonly widthNs: number;
  readonly length: number;
  counts(key: K): readonly number[];
  total(key: K): number;
}

/** One stacked series of a histogram: its bucket key, legend label, and a `var(--oh-…)` colour token. */
export interface HistogramSeries<K extends string> {
  key: K;
  label: string;
  color: string;
}

/** Span status series, bottom of the stack first; errors keep their hatch. */
export const SPAN_STATUS_SERIES: readonly HistogramSeries<SpanStatusKey>[] = [
  { key: 'ok', label: 'ok', color: 'var(--oh-series-1)' },
  { key: 'error', label: 'error', color: 'var(--oh-critical)' },
  { key: 'unset', label: 'unset', color: 'var(--oh-series-other)' },
];

/** Log severity series in legend order, most severe first (pass `topFirst` so fatal stacks on top). */
export const SEVERITY_SERIES: readonly HistogramSeries<LogSeverityKey>[] = [
  { key: 'fatal', label: 'FATAL', color: 'var(--oh-sev-fatal)' },
  { key: 'error', label: 'ERROR', color: 'var(--oh-sev-error)' },
  { key: 'warn', label: 'WARN', color: 'var(--oh-sev-warn)' },
  { key: 'info', label: 'INFO', color: 'var(--oh-sev-info)' },
  { key: 'debug', label: 'DEBUG', color: 'var(--oh-sev-debug)' },
  { key: 'trace', label: 'TRACE', color: 'var(--oh-sev-trace)' },
  { key: 'unspecified', label: 'UNSPECIFIED', color: 'var(--oh-sev-unspecified)' },
];

/** Sum runs of neighbouring buckets so at most `maxColumns` remain; columns stay aligned to `startNs`. */
export function coarsenBuckets<K extends string>(
  b: BucketView<K>,
  maxColumns = HISTOGRAM_MAX_COLUMNS,
): BucketView<K> {
  const f = Math.ceil(b.length / maxColumns);
  if (f <= 1) return b;
  const length = Math.ceil(b.length / f);
  const sums = new Map<K, number[]>();
  for (const k of b.keys) {
    const src = b.counts(k);
    const out = new Array<number>(length).fill(0);
    for (let i = 0; i < b.length; i++) {
      const j = Math.floor(i / f);
      out[j] = (out[j] ?? 0) + (src[i] ?? 0);
    }
    sums.set(k, out);
  }
  return {
    keys: b.keys,
    startNs: b.startNs,
    widthNs: b.widthNs * f,
    length,
    counts: (k) => sums.get(k) ?? [],
    total: (k) => b.total(k),
  };
}

/** Inclusive bucket indexes (either order) to a half-open window in the buckets' time unit. */
export function brushToWindow<K extends string>(
  b: BucketView<K>,
  from: number,
  to: number,
  /** The run's end; the last bucket is wider than the data, so the window never extends past it. */
  rangeEnd?: number,
): TimeWindow {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const end = b.startNs + (hi + 1) * b.widthNs;
  const start = b.startNs + lo * b.widthNs;
  return { start, end: rangeEnd === undefined ? end : Math.max(start, Math.min(end, rangeEnd)) };
}

const VAR_RE = /^var\((--[a-z0-9-]+)\)$/;

/** Resolve a `var(--token)` reference against the live theme; anything else (or an unset token) is returned as is. */
function resolveColor(color: string): string {
  const name = VAR_RE.exec(color)?.[1];
  if (name === undefined) return color;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === '' ? color : v;
}

function seconds(ns: number): string {
  return `${(ns / 1e9).toFixed(ns % 1e9 === 0 ? 0 : 1)}s`;
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function buildHistogramOption<K extends string>(
  b: BucketView<K>,
  series: readonly HistogramSeries<K>[],
  /** Stack the first series on top (legend order matches the stack, top to bottom). */
  topFirst = false,
) {
  const x = Array.from({ length: b.length }, (_, i) => seconds(b.startNs + i * b.widthNs));
  const bars = series.map((s) => {
    const color = resolveColor(s.color);
    return {
      name: s.label,
      type: 'bar',
      stack: 'total',
      data: Array.from({ length: b.length }, (_, i) => b.counts(s.key)[i] ?? 0),
      itemStyle:
        s.key === 'error'
          ? {
              color,
              // Colour is never the only encoding for errors: a hatch pattern repeats it.
              decal: {
                symbol: 'rect',
                dashArrayX: [1, 0],
                dashArrayY: [2, 3],
                rotation: Math.PI / 4,
                color: 'rgba(255,255,255,0.6)',
              },
            }
          : { color },
    };
  });
  return {
    animation: false,
    grid: { ...GRID, containLabel: false },
    legend: { top: 0, left: GRID.left, data: series.map((s) => s.label) },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: x, axisTick: { show: false } },
    yAxis: { type: 'value', minInterval: 1 },
    // ECharts stacks the first series at the bottom.
    series: topFirst ? bars.reverse() : bars,
  };
}

/** Stacked histogram over time. Drag (or use the keyboard) to brush a window into the selection. */
export function HistogramCard<K extends string>(props: {
  buckets: TimeBuckets<K>;
  series: readonly HistogramSeries<K>[];
  rangeEnd?: number;
  /** Card heading and noun for the totals: "Spans over time" by default, e.g. "Logs over time". */
  title?: string;
  /** Stack the first series on top (severity: fatal). */
  topFirst?: boolean;
}): JSX.Element {
  const buckets = useMemo(() => coarsenBuckets(props.buckets), [props.buckets]);
  const setWindow = useSelection((s) => s.setWindow);
  const [themeTick, setThemeTick] = useState(0);
  const [range, setRange] = useState<{ anchor: number; cursor: number } | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => mo.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: themeTick re-reads the CSS colour tokens
  const option = useMemo(
    () => buildHistogramOption(buckets, props.series, props.topFirst),
    [buckets, props.series, props.topFirst, themeTick],
  );
  const total = sum(buckets.keys.map((k) => buckets.total(k)));
  const title = props.title ?? 'Spans over time';
  const noun = (title.split(' ')[0] ?? 'spans').toLowerCase();
  // The series keyed `error` (span status or log severity) gets its own count beside the total.
  const errorSeries = props.series.find((s) => s.key === 'error');
  const errors = errorSeries === undefined ? null : buckets.total(errorSeries.key);
  const last = Math.max(0, buckets.length - 1);

  const indexAt = (e: PointerEvent<HTMLDivElement>): number => {
    const el = overlay.current;
    if (el === null || buckets.length === 0) return 0;
    const r = el.getBoundingClientRect();
    const f = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
    return Math.min(last, Math.max(0, Math.floor(f * buckets.length)));
  };

  const commit = (r: { anchor: number; cursor: number }): void => {
    setWindow(brushToWindow(buckets, r.anchor, r.cursor, props.rangeEnd));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (buckets.length === 0) return;
    const cur = range?.cursor ?? 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cursor = Math.min(last, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
      // Shift keeps the existing anchor and extends from it; a plain arrow moves a single-bucket brush.
      setRange({ anchor: e.shiftKey ? (range?.anchor ?? cur) : cursor, cursor });
    } else if (e.key === 'Enter' && range !== null) {
      e.preventDefault();
      commit(range);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setRange(null);
      setWindow(null);
    }
  };

  const lo = range === null ? 0 : Math.min(range.anchor, range.cursor);
  const hi = range === null ? 0 : Math.max(range.anchor, range.cursor);
  const col = 100 / Math.max(1, buckets.length);

  return (
    <section aria-label={title} className="rounded-card border border-hairline bg-surface p-3">
      <div className="mb-1 flex items-baseline gap-3 text-sm">
        <span className="font-mono tabular-nums">
          {total} {noun}
        </span>
        {errorSeries !== undefined && (
          <span className="font-mono tabular-nums text-critical">
            {errors} {errorSeries.label.toLowerCase()}s
          </span>
        )}
        <span className="ml-auto text-xs text-muted">
          Drag to select a time range; arrow keys and Enter also work
        </span>
      </div>
      <div className="relative">
        <Chart
          option={option}
          height={160}
          ariaLabel={`${title}: ${total} ${noun}${errorSeries === undefined ? '' : `, ${errors} ${errorSeries.label.toLowerCase()}s`}`}
        />
        {/* biome-ignore lint/a11y/useSemanticElements: a custom brush widget, not a form field group */}
        <div
          ref={overlay}
          role="group"
          aria-label="Time brush"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-operable brush (arrows, Shift, Enter, Escape)
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            const i = indexAt(e);
            setRange({ anchor: i, cursor: i });
          }}
          onPointerMove={(e) => {
            if (dragging.current)
              setRange((r) => (r === null ? r : { anchor: r.anchor, cursor: indexAt(e) }));
          }}
          onPointerUp={(e) => {
            if (!dragging.current) return;
            dragging.current = false;
            const r = range === null ? null : { anchor: range.anchor, cursor: indexAt(e) };
            if (r !== null) {
              setRange(r);
              commit(r);
            }
          }}
          className="absolute cursor-crosshair rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          style={{ left: GRID.left, right: GRID.right, top: GRID.top, bottom: GRID.bottom }}
        >
          {range === null ? null : (
            <div
              aria-hidden
              className="absolute inset-y-0 border-x border-ink bg-ink/10"
              style={{ left: `${lo * col}%`, width: `${(hi - lo + 1) * col}%` }}
            />
          )}
        </div>
      </div>
    </section>
  );
}
