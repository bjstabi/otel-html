import { type JSX, type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { SpanStatusKey } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import type { TimeWindow } from '../data/span-query.js';
import { useSelection } from '../state/selection-context.js';
import { STATUS } from '../theme/palette.js';
import { Chart } from './chart.js';

/** Plot insets in px; the brush overlay uses the same values so pointer x maps onto bucket columns. */
const GRID = { left: 40, right: 8, top: 24, bottom: 24 } as const;

/** Inclusive bucket indexes (either order) to a half-open window in the buckets' time unit. */
export function brushToWindow(
  b: TimeBuckets<SpanStatusKey>,
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

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === '' ? fallback : v;
}

function seconds(ns: number): string {
  return `${(ns / 1e9).toFixed(ns % 1e9 === 0 ? 0 : 1)}s`;
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function buildHistogramOption(b: TimeBuckets<SpanStatusKey>) {
  const colors: Record<SpanStatusKey, string> = {
    ok: token('--oh-series-1', '#2a78d6'),
    error: token('--oh-critical', STATUS.critical),
    unset: token('--oh-series-other', '#9aa0a6'),
  };
  const x = Array.from({ length: b.length }, (_, i) => seconds(b.startNs + i * b.widthNs));
  return {
    animation: false,
    grid: { ...GRID, containLabel: false },
    legend: { top: 0, left: GRID.left },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: x, axisTick: { show: false } },
    yAxis: { type: 'value', minInterval: 1 },
    series: b.keys.map((k) => ({
      name: k,
      type: 'bar',
      stack: 'status',
      data: Array.from({ length: b.length }, (_, i) => b.counts(k)[i] ?? 0),
      itemStyle:
        k === 'error'
          ? {
              color: colors[k],
              // Colour is never the only encoding for errors: a hatch pattern repeats it.
              decal: {
                symbol: 'rect',
                dashArrayX: [1, 0],
                dashArrayY: [2, 3],
                rotation: Math.PI / 4,
                color: 'rgba(255,255,255,0.6)',
              },
            }
          : { color: colors[k] },
    })),
  };
}

/** Stacked status histogram over time. Drag (or use the keyboard) to brush a window into the selection. */
export function HistogramCard(props: {
  buckets: TimeBuckets<SpanStatusKey>;
  rangeEnd?: number;
}): JSX.Element {
  const { buckets } = props;
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
  const option = useMemo(() => buildHistogramOption(buckets), [buckets, themeTick]);
  const total = sum(buckets.keys.map((k) => buckets.total(k)));
  const errors = buckets.total('error');
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
    <section aria-label="Spans over time" className="rounded-card border border-hairline bg-surface p-3">
      <div className="mb-1 flex items-baseline gap-3 text-sm">
        <span className="font-mono tabular-nums">{total} spans</span>
        <span className="font-mono tabular-nums text-critical">{errors} errors</span>
        <span className="ml-auto text-xs text-muted">
          Drag to select a time range; arrow keys and Enter also work
        </span>
      </div>
      <div className="relative">
        <Chart
          option={option}
          height={160}
          ariaLabel={`Spans over time by status: ${total} spans, ${errors} errors`}
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
