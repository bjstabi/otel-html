import { type CSSProperties, type JSX, type KeyboardEvent, useRef, useState } from 'react';

/** Inclusive column indexes, in either order. */
export interface ColumnRange {
  anchor: number;
  cursor: number;
}

/** Pixels the pointer may move between press and release and still count as a click. */
const CLICK_SLOP_PX = 3;

/**
 * The pointer and keyboard brush over a chart's plot, in columns. Drag (or arrows, Shift to extend, Enter) selects;
 * Escape clears. With `clickClears` a click without a drag clears and the caller draws the committed brush through
 * `shown`; without it a click commits its one column and the overlay keeps drawing it.
 */
export function BrushOverlay(props: {
  /** Columns under the overlay. */
  length: number;
  clickClears: boolean;
  /** The committed brush as inclusive columns, drawn while no drag is in progress. */
  shown?: { lo: number; hi: number } | null;
  onCommit(r: ColumnRange): void;
  onClear(): void;
  style: CSSProperties;
}): JSX.Element {
  const { length, clickClears, onCommit, onClear } = props;
  const [range, setRange] = useState<ColumnRange | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number } | null>(null);
  const last = Math.max(0, length - 1);

  const indexAt = (clientX: number): number => {
    const el = overlay.current;
    if (el === null || length === 0) return 0;
    const r = el.getBoundingClientRect();
    const f = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return Math.min(last, Math.max(0, Math.floor(f * length)));
  };

  const abandon = (): void => {
    press.current = null;
    setRange(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (length === 0) return;
    const cur = range?.cursor ?? 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cursor = Math.min(last, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
      // Shift keeps the existing anchor and extends from it; a plain arrow moves a single-column brush.
      setRange({ anchor: e.shiftKey ? (range?.anchor ?? cur) : cursor, cursor });
    } else if (e.key === 'Enter' && range !== null) {
      e.preventDefault();
      onCommit(range);
      if (clickClears) setRange(null);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setRange(null);
      onClear();
    }
  };

  const shown =
    range !== null
      ? { lo: Math.min(range.anchor, range.cursor), hi: Math.max(range.anchor, range.cursor) }
      : (props.shown ?? null);
  const col = 100 / Math.max(1, length);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a custom brush widget, not a form field group
    <div
      ref={overlay}
      role="group"
      aria-label="Time brush"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-operable brush (arrows, Shift, Enter, Escape)
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
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
        if (clickClears && Math.abs(e.clientX - down.x) <= CLICK_SLOP_PX) {
          setRange(null);
          onClear();
          return;
        }
        const r = { anchor: range.anchor, cursor: indexAt(e.clientX) };
        setRange(clickClears ? null : r);
        onCommit(r);
      }}
      onPointerCancel={abandon}
      className="absolute cursor-crosshair rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      style={props.style}
    >
      {shown === null ? null : (
        <div
          aria-hidden
          className="absolute inset-y-0 border-x border-ink bg-ink/10"
          style={{ left: `${shown.lo * col}%`, width: `${(shown.hi - shown.lo + 1) * col}%` }}
        />
      )}
    </div>
  );
}
