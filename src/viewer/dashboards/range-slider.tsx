import { type JSX, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { EDGE_SNAP, rangeLabel, stamp } from './range-label.js';

type Range = [number, number];
type Handle = 'start' | 'end' | 'body' | 'new';

/** The smallest zoom, as a share of the extent. */
const MIN_SHARE = 0.001;

export interface RangeSliderProps {
  extent: Range;
  /** The zoom, inside the extent; null shows the whole extent. */
  zoom: Range | null;
  /** Marks along the track (empty until the CI widgets). */
  ticks: readonly { t: number; color: string }[];
  /** Turns run-relative times into dates for the handles' `aria-valuetext` (default 0). */
  epoch?: bigint;
  /** Called with each new zoom while dragging; null is the whole extent. */
  onZoom(zoom: Range | null): void;
  /** Called when a drag ends, after its last `onZoom`. */
  onRelease?(): void;
}

/** Snaps an edge within 0.5 % of the extent's edge to it. */
function snap(v: number, [e0, e1]: Range): number {
  const tol = (e1 - e0) * EDGE_SNAP;
  if (Math.abs(v - e0) <= tol) return e0;
  if (Math.abs(v - e1) <= tol) return e1;
  return v;
}

/** Whole nanoseconds: a window in the URL is integers, and a pixel is rarely a whole number of them. */
const whole = ([a, b]: Range): Range => [Math.round(a), Math.round(b)];

/** The new zoom after dragging `handle` to `at` (body: by `delta` from `from`), clamped to the extent. */
function dragged(handle: Handle, from: Range, at: number, delta: number, extent: Range): Range {
  const [e0, e1] = extent;
  const gap = (e1 - e0) * MIN_SHARE;
  if (handle === 'start') return whole([snap(Math.max(e0, Math.min(at, from[1] - gap)), extent), from[1]]);
  if (handle === 'end') return whole([from[0], snap(Math.min(e1, Math.max(at, from[0] + gap)), extent)]);
  const width = from[1] - from[0];
  const start = Math.max(e0, Math.min(from[0] + delta, e1 - width));
  return whole([snap(start, extent), snap(start + width, extent)]);
}

/** The zoom held inside the extent (a link may carry a window the page range no longer contains). */
function within(z: Range, [e0, e1]: Range): Range {
  const a = Math.max(e0, Math.min(z[0], e1));
  return [a, Math.max(a, Math.min(z[1], e1))];
}

/** The zoom drawn from `anchor` to `at` (either order), inside the extent, snapped at the edges. */
function drawn(anchor: number, at: number, extent: Range): Range {
  const [e0, e1] = extent;
  const gap = (e1 - e0) * MIN_SHARE;
  const lo = Math.max(e0, Math.min(anchor, at));
  const hi = Math.min(e1, Math.max(anchor, at));
  const a = snap(Math.min(lo, e1 - gap), extent);
  return whole([a, snap(Math.max(hi, a + gap), extent)]);
}

const HANDLE =
  'absolute top-0 h-7 w-6 -translate-x-1/2 cursor-ew-resize rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/**
 * A slider over the page range: two handles and the band between them (drag it to pan; drag across the bare track to
 * draw a new range). Double-click returns to the whole extent. Calls `onZoom` on every move; the caller throttles
 * what it writes. Handles are 24 px wide whatever the track's width.
 */
export function RangeSlider(props: RangeSliderProps): JSX.Element {
  const { extent, zoom, ticks, onZoom, onRelease } = props;
  const epoch = props.epoch ?? 0n;
  const [draft, setDraft] = useState<Range | null>(null);
  const drag = useRef<{ handle: Handle; from: Range; x0: number; anchor: number } | null>(null);
  // the last zoom this slider emitted, until the caller's `zoom` catches up (key repeats within one frame build on it)
  const emitted = useRef<Range | null>(null);
  useEffect(() => {
    emitted.current = null; // every render of the caller's state ends the wait (a new `zoom` arrives with it)
  });
  const emit = (next: Range): void => {
    emitted.current = next;
    onZoom(next[0] === extent[0] && next[1] === extent[1] ? null : next);
  };
  const shown = within(draft ?? zoom ?? extent, extent);
  const span = extent[1] - extent[0];
  const pct = (t: number): number => (span === 0 ? 0 : ((t - extent[0]) / span) * 100);

  const valueAt = (e: React.PointerEvent<HTMLElement>): { at: number; delta: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    const width = rect.width === 0 ? 1000 : rect.width;
    const at = extent[0] + ((e.clientX - rect.left) / width) * span;
    return { at, delta: ((e.clientX - (drag.current?.x0 ?? 0)) / width) * span };
  };

  const start = (handle: Handle) => (e: React.PointerEvent<HTMLElement>) => {
    drag.current = { handle, from: shown, x0: e.clientX, anchor: 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.stopPropagation();
  };
  const startDraw = (e: React.PointerEvent<HTMLElement>) => {
    drag.current = { handle: 'new', from: shown, x0: e.clientX, anchor: valueAt(e).at };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === null) return;
    const { at, delta } = valueAt(e);
    const next =
      d.handle === 'new' ? drawn(d.anchor, at, extent) : dragged(d.handle, d.from, at, delta, extent);
    setDraft(next);
    emit(next);
  };
  const end = () => {
    if (drag.current === null) return;
    drag.current = null;
    setDraft(null);
    onRelease?.();
  };
  const key = (handle: 'start' | 'end') => (e: React.KeyboardEvent<HTMLElement>) => {
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const step = span * (e.shiftKey ? 0.1 : 0.01) * dir;
    const from = within(emitted.current ?? zoom ?? extent, extent);
    const at = (handle === 'start' ? from[0] : from[1]) + step;
    emit(dragged(handle, from, at, 0, extent));
  };

  const [s0, s1] = [pct(shown[0]), pct(shown[1])];
  const handle = (which: 'start' | 'end', value: number, left: number): JSX.Element => (
    <div
      data-part={which}
      role="slider"
      aria-label={which === 'start' ? 'Zoom start' : 'Zoom end'}
      aria-valuemin={extent[0]}
      aria-valuemax={extent[1]}
      aria-valuenow={value}
      aria-valuetext={stamp(value, epoch)}
      tabIndex={0}
      style={{ left: `${left}%` }}
      className={HANDLE}
      onKeyDown={key(which)}
      onPointerDown={start(which)}
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-1/2 w-1.5 -translate-x-1/2 rounded-sm bg-accent"
      />
    </div>
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pointer surface, not a form group; the handles inside are the keyboard interface
    <div
      role="group"
      aria-label="Zoom range"
      data-testid="range-slider"
      className="relative h-7 w-full touch-none select-none"
      onPointerDown={startDraw}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onZoom(null)}
    >
      <div className="absolute inset-x-0 top-2.5 h-2 rounded-full bg-hairline" />
      {ticks.map((tick) => (
        <div
          key={tick.t}
          className="absolute top-1.5 h-4 w-0.5"
          style={{ left: `${pct(tick.t)}%`, backgroundColor: tick.color }}
        />
      ))}
      <div
        data-part="body"
        className="absolute top-2.5 h-2 cursor-grab bg-accent opacity-40"
        style={{ left: `${s0}%`, width: `${Math.max(0, s1 - s0)}%` }}
        onPointerDown={start('body')}
      />
      {handle('start', shown[0], s0)}
      {handle('end', shown[1], s1)}
    </div>
  );
}

/** A writer that calls `write` with the latest value at most once per animation frame, and `flush` to write it now. */
function useFrameWriter<T>(write: (v: T) => void): { write: (v: T) => void; flush: () => void } {
  const latest = useRef(write);
  latest.current = write;
  const pending = useRef<{ v: T } | null>(null);
  const frame = useRef<number | null>(null);
  const run = useCallback(() => {
    frame.current = null;
    const p = pending.current;
    pending.current = null;
    if (p !== null) latest.current(p.v);
  }, []);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const put = useCallback(
    (v: T) => {
      pending.current = { v };
      if (frame.current === null) frame.current = requestAnimationFrame(run);
    },
    [run],
  );
  const flush = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    run();
  }, [run]);
  return { write: put, flush };
}

/** The slider with its header line (the extent, and what is selected). */
export function ZoomRow(props: {
  extent: Range;
  zoom: Range | null;
  preset: string | null;
  epoch: bigint;
  onZoom(zoom: Range | null): void;
  /** False where the range dropdown beside it already says it (the filter bar). */
  label?: boolean;
  ticks?: readonly { t: number; color: string }[];
  /** How many runs are selected: "all <count> selected" unzoomed, "· <count>" after the zoom's duration. */
  count?: ReactNode;
}): JSX.Element {
  const frames = useFrameWriter(props.onZoom);
  const l = rangeLabel(props);
  const { count } = props;
  const has = count !== undefined && count !== null && count !== false;
  return (
    <div className="flex flex-col gap-1" data-testid="zoom-row">
      <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
        <span className={l.zoomed ? 'hidden sm:inline' : ''} data-testid="zoom-extent">
          {stamp(props.extent[0], props.epoch)} – {stamp(props.extent[1], props.epoch)}
        </span>
        <span className="ml-auto text-right" data-testid="zoom-selection">
          {l.zoomed ? (
            <>
              {l.header}
              {has && <> · {count}</>}
            </>
          ) : (
            <>all {has && <>{count} </>}selected · drag to zoom</>
          )}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {props.label === false ? null : (
          <span className="shrink-0 text-sm text-ink-2" title={l.header || undefined}>
            {l.label}
            {l.of}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <RangeSlider
            extent={props.extent}
            zoom={props.zoom}
            ticks={props.ticks ?? []}
            epoch={props.epoch}
            onZoom={frames.write}
            onRelease={frames.flush}
          />
        </div>
      </div>
    </div>
  );
}
