import { type JSX, type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from 'react';

export const SPLIT_MIN = 20;
export const SPLIT_MAX = 80;
const KEY_STEP = 5;
export const SPLIT_STORAGE_KEY = 'oh:trace-split';

/** Percentage given to the top pane, kept within 20..80 so each pane keeps at least 20%. */
export function clampSplit(pct: number): number {
  if (!Number.isFinite(pct)) return 50;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct));
}

function readStored(): number {
  try {
    const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
    if (raw === null) return 55;
    const n = Number(raw);
    return Number.isFinite(n) ? clampSplit(n) : 55;
  } catch {
    return 55;
  }
}

function store(pct: number): void {
  try {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, String(pct));
  } catch {
    // Storage is optional (private windows, blocked site data): the split just is not remembered.
  }
}

/** Two stacked panes with a draggable, keyboard-operable separator (arrows, Home, End) that is remembered. */
export function SplitPane(props: { top: ReactNode; bottom: ReactNode; label: string }): JSX.Element {
  const [pct, setPct] = useState<number>(readStored);
  const host = useRef<HTMLDivElement>(null);

  const commit = (next: number): void => {
    const v = Math.round(clampSplit(next) * 10) / 10;
    setPct(v);
    store(v);
  };

  const fromPointer = (e: PointerEvent<HTMLDivElement>): void => {
    const box = host.current?.getBoundingClientRect();
    if (box === undefined || box.height === 0) return;
    commit(((e.clientY - box.top) / box.height) * 100);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        commit(pct - KEY_STEP);
        break;
      case 'ArrowDown':
        e.preventDefault();
        commit(pct + KEY_STEP);
        break;
      case 'Home':
        e.preventDefault();
        commit(SPLIT_MIN);
        break;
      case 'End':
        e.preventDefault();
        commit(SPLIT_MAX);
        break;
    }
  };

  return (
    <div ref={host} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 overflow-auto" style={{ flexBasis: `${pct}%`, flexGrow: 0, flexShrink: 0 }}>
        {props.top}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a window splitter is a focusable separator; <hr> cannot take focus or keys */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={props.label}
        aria-valuemin={SPLIT_MIN}
        aria-valuemax={SPLIT_MAX}
        aria-valuenow={Math.round(pct)}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
        className="group flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span aria-hidden className="h-1 w-12 rounded-full bg-hairline group-hover:bg-muted" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{props.bottom}</div>
    </div>
  );
}
