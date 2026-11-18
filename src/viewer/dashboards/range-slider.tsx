import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import { EDGE_SNAP, rangeLabel } from './range-label.js';

type Range = [number, number];
type Handle = 'start' | 'end' | 'body';

const WIDTH = 1000;
const HEIGHT = 28;
/** The smallest zoom, as a share of the extent. */
const MIN_SHARE = 0.001;

export interface RangeSliderProps {
  extent: Range;
  /** The zoom, inside the extent; null shows the whole extent. */
  zoom: Range | null;
  /** Marks along the track (empty until the CI widgets). */
  ticks: readonly { t: number; color: string }[];
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

/**
 * A slider over the page range: two handles and the band between them (drag it to pan). Double-click returns to the
 * whole extent. Calls `onZoom` on every move; the caller throttles what it writes.
 */
export function RangeSlider(props: RangeSliderProps): JSX.Element {
  const { extent, zoom, ticks, onZoom, onRelease } = props;
  const [draft, setDraft] = useState<Range | null>(null);
  const drag = useRef<{ handle: Handle; from: Range; x0: number } | null>(null);
  // the last zoom this slider emitted, until the caller's `zoom` catches up (key repeats within one frame build on it)
  const emitted = useRef<Range | null>(null);
  useEffect(() => {
    emitted.current = null; // every render of the caller's state ends the wait (a new `zoom` arrives with it)
  });
  const emit = (next: Range): void => {
    emitted.current = next;
    onZoom(next[0] === extent[0] && next[1] === extent[1] ? null : next);
  };
  const shown = draft ?? zoom ?? extent;
  const span = extent[1] - extent[0];
  const x = (t: number): number => (span === 0 ? 0 : ((t - extent[0]) / span) * WIDTH);

  const valueAt = (e: React.PointerEvent<SVGSVGElement>): { at: number; delta: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    const width = rect.width === 0 ? WIDTH : rect.width;
    const at = extent[0] + ((e.clientX - rect.left) / width) * span;
    return { at, delta: ((e.clientX - (drag.current?.x0 ?? 0)) / width) * span };
  };

  const start = (handle: Handle) => (e: React.PointerEvent<SVGElement>) => {
    drag.current = { handle, from: shown, x0: e.clientX };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.stopPropagation();
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d === null) return;
    const { at, delta } = valueAt(e);
    const next = dragged(d.handle, d.from, at, delta, extent);
    setDraft(next);
    emit(next);
  };
  const end = () => {
    if (drag.current === null) return;
    drag.current = null;
    setDraft(null);
    onRelease?.();
  };
  const key = (handle: 'start' | 'end') => (e: React.KeyboardEvent<SVGElement>) => {
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const step = span * (e.shiftKey ? 0.1 : 0.01) * dir;
    const from = emitted.current ?? zoom ?? extent;
    const at = (handle === 'start' ? from[0] : from[1]) + step;
    emit(dragged(handle, from, at, 0, extent));
  };

  const [s0, s1] = [x(shown[0]), x(shown[1])];
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="h-7 w-full touch-none select-none"
      aria-label="Zoom range"
      data-testid="range-slider"
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onZoom(null)}
    >
      <rect x={0} y={10} width={WIDTH} height={8} rx={4} className="fill-hairline" />
      {ticks.map((tick) => (
        <rect key={tick.t} x={x(tick.t)} y={6} width={2} height={16} fill={tick.color} />
      ))}
      <rect
        data-part="body"
        x={s0}
        y={10}
        width={Math.max(0, s1 - s0)}
        height={8}
        className="cursor-grab fill-accent opacity-40"
        onPointerDown={start('body')}
      />
      <rect
        data-part="start"
        role="slider"
        aria-label="Zoom start"
        aria-valuemin={extent[0]}
        aria-valuemax={extent[1]}
        aria-valuenow={shown[0]}
        x={s0 - 5}
        y={3}
        width={10}
        height={22}
        rx={3}
        className="cursor-ew-resize fill-accent"
        tabIndex={0}
        onKeyDown={key('start')}
        onPointerDown={start('start')}
      />
      <rect
        data-part="end"
        role="slider"
        aria-label="Zoom end"
        aria-valuemin={extent[0]}
        aria-valuemax={extent[1]}
        aria-valuenow={shown[1]}
        x={s1 - 5}
        y={3}
        width={10}
        height={22}
        rx={3}
        className="cursor-ew-resize fill-accent"
        tabIndex={0}
        onKeyDown={key('end')}
        onPointerDown={start('end')}
      />
    </svg>
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

/** The slider with its label: what Task 12 moves into the filter bar's slider row. */
export function ZoomRow(props: {
  extent: Range;
  zoom: Range | null;
  preset: string | null;
  epoch: bigint;
  onZoom(zoom: Range | null): void;
  /** False where the range dropdown beside it already says it (the filter bar). */
  label?: boolean;
}): JSX.Element {
  const frames = useFrameWriter(props.onZoom);
  const l = rangeLabel(props);
  return (
    <div className="flex items-center gap-3" data-testid="zoom-row">
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
          ticks={[]}
          onZoom={frames.write}
          onRelease={frames.flush}
        />
      </div>
    </div>
  );
}
