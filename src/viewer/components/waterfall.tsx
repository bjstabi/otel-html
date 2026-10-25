// biome-ignore-all lint/a11y/useSemanticElements: a virtualized tree positions rows absolutely, which native lists cannot do; the ARIA tree roles carry the semantics
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, CircleAlert } from 'lucide-react';
import { type JSX, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { SpanId } from '../../model/ids.js';
import { StatusCode } from '../../model/records.js';
import { formatDuration } from '../../semconv/formatters.js';
import type { TraceNode, TraceTree } from '../data/trace-tree.js';
import { type ColorAssigner, createColorAssigner, OTHER_INDEX } from '../theme/palette.js';
import { ServiceChip } from '../traces/columns.js';
import { rectWithFallback } from './results-table.js';

const ROW_HEIGHT = 32;
const INDENT_PX = 14;
const MAX_INDENT_LEVELS = 40;
const AXIS_TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

interface FlatRow {
  node: TraceNode;
}

/** Pre-order list of the visible nodes; a collapsed node hides its subtree. Iterative (50k spans, deep chains). */
export function flattenVisible(tree: TraceTree, collapsed: ReadonlySet<TraceNode>): FlatRow[] {
  const out: FlatRow[] = [];
  const stack: TraceNode[] = [];
  for (let i = tree.roots.length - 1; i >= 0; i--) {
    const r = tree.roots[i];
    if (r !== undefined) stack.push(r);
  }
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    out.push({ node: n });
    if (collapsed.has(n)) continue;
    for (let i = n.children.length - 1; i >= 0; i--) {
      const c = n.children[i];
      if (c !== undefined) stack.push(c);
    }
  }
  return out;
}

/** Shared time axis: the earliest start and latest end over every span, orphans and skewed children included. */
export function traceExtent(tree: TraceTree): { start: number; end: number } {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  const stack = [...tree.roots];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (n.row.span.start < start) start = n.row.span.start;
    if (n.row.span.end > end) end = n.row.span.end;
    for (const c of n.children) stack.push(c);
  }
  return start === Number.POSITIVE_INFINITY
    ? { start: 0, end: 1 }
    : { start, end: end > start ? end : start + 1 };
}

export interface WaterfallProps {
  tree: TraceTree;
  selectedSpanId: SpanId | null;
  onSelect(spanId: SpanId): void;
  colors?: ColorAssigner;
  /** Scroll viewport height in px (default 420). */
  height?: number;
}

const seriesVar = (i: number): string =>
  i >= OTHER_INDEX ? 'var(--oh-series-other)' : `var(--oh-series-${i + 1})`;

const HATCH = 'repeating-linear-gradient(135deg, rgba(255,255,255,0.55) 0 3px, transparent 3px 6px)';

/** Virtualized waterfall: rows indented by depth, collapse/expand, duration bars on one shared time axis. */
export function Waterfall(props: WaterfallProps): JSX.Element {
  const { tree, selectedSpanId, onSelect } = props;
  const height = props.height ?? 420;
  const fallbackColors = useMemo(() => createColorAssigner(), []);
  const colors = props.colors ?? fallbackColors;
  const [collapsed, setCollapsed] = useState<ReadonlySet<TraceNode>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);

  const rows = useMemo(() => flattenVisible(tree, collapsed), [tree, collapsed]);
  const extent = useMemo(() => traceExtent(tree), [tree]);
  const span = extent.end - extent.start;

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    initialRect: { width: 0, height },
    observeElementRect: rectWithFallback(height),
  });

  const toggle = (n: TraceNode, open: boolean): void => {
    const next = new Set(collapsed);
    if (open) next.delete(n);
    else next.add(n);
    setCollapsed(next);
  };

  const focusIndex = (i: number): void => {
    virtual.scrollToIndex(i);
    const el = scroller.current?.querySelector<HTMLElement>(`[data-row-index="${i}"]`);
    if (el) el.focus();
    else pendingFocus.current = i;
  };
  useEffect(() => {
    const i = pendingFocus.current;
    if (i === null) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-row-index="${i}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  });

  const onKey = (e: KeyboardEvent<HTMLDivElement>, index: number): void => {
    const row = rows[index];
    if (row === undefined) return;
    const n = row.node;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusIndex(Math.min(rows.length - 1, index + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusIndex(Math.max(0, index - 1));
        break;
      case 'Home':
        e.preventDefault();
        focusIndex(0);
        break;
      case 'End':
        e.preventDefault();
        focusIndex(rows.length - 1);
        break;
      case 'ArrowRight':
        if (n.children.length > 0 && collapsed.has(n)) {
          e.preventDefault();
          toggle(n, true);
        }
        break;
      case 'ArrowLeft':
        if (n.children.length > 0 && !collapsed.has(n)) {
          e.preventDefault();
          toggle(n, false);
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect(n.row.span.spanId);
        break;
    }
  };

  const selectedIndex =
    selectedSpanId === null ? -1 : rows.findIndex((r) => r.node.row.span.spanId === selectedSpanId);
  const tabbable = Math.max(0, selectedIndex);

  return (
    <div className="overflow-hidden rounded-card border border-hairline bg-surface" data-testid="waterfall">
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 border-b border-hairline bg-page px-3 py-1.5 text-xs text-ink-2">
        <span>Span</span>
        <span className="relative h-4 font-mono tabular-nums" aria-hidden>
          {AXIS_TICKS.map((t) => (
            <span
              key={t}
              className="absolute top-0"
              style={{
                left: `${t * 100}%`,
                transform: t === 1 ? 'translateX(-100%)' : t === 0 ? 'none' : 'translateX(-50%)',
              }}
            >
              {formatDuration(span * t)}
            </span>
          ))}
        </span>
      </div>
      <div
        ref={scroller}
        role="tree"
        aria-label="Waterfall"
        aria-multiselectable={false}
        className="overflow-auto"
        style={{ height }}
      >
        <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((v) => {
            const row = rows[v.index];
            if (row === undefined) return null;
            const n = row.node;
            const s = n.row.span;
            const selected = s.spanId === selectedSpanId;
            const hasChildren = n.children.length > 0;
            const open = !collapsed.has(n);
            const error = s.status.code === StatusCode.ERROR;
            const left = Math.min(100, Math.max(0, ((s.start - extent.start) / span) * 100));
            const width = Math.min(100 - left, Math.max(0, ((s.end - s.start) / span) * 100));
            const index = v.index;
            return (
              <div
                key={`${s.spanId}:${index}`}
                role="treeitem"
                aria-level={n.depth + 1}
                aria-expanded={hasChildren ? open : undefined}
                aria-selected={selected}
                data-row-index={index}
                data-selected={selected ? 'true' : undefined}
                data-span-id={s.spanId}
                tabIndex={index === tabbable ? 0 : -1}
                onClick={() => onSelect(s.spanId)}
                onKeyDown={(e) => onKey(e, index)}
                className={`absolute left-0 grid w-full cursor-pointer grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-2 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  selected ? 'bg-ink text-surface' : 'hover:bg-page'
                }`}
                style={{ top: 0, height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}
              >
                <div
                  className="flex min-w-0 items-center gap-1.5"
                  style={{ paddingLeft: Math.min(n.depth, MAX_INDENT_LEVELS) * INDENT_PX }}
                >
                  {hasChildren ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={open ? 'Collapse children' : 'Expand children'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(n, !open);
                      }}
                      className="shrink-0 rounded-full p-0.5 hover:bg-hairline/60"
                    >
                      {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                    </button>
                  ) : (
                    <span aria-hidden className="inline-block w-[18px] shrink-0" />
                  )}
                  <span className="shrink-0 text-xs">
                    <ServiceChip service={n.row.service} colors={colors} />
                  </span>
                  <span className="min-w-0 truncate">{s.name}</span>
                  {error && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold">
                      <CircleAlert size={13} aria-hidden />
                      error
                    </span>
                  )}
                </div>
                <div className="relative h-5">
                  <span
                    aria-hidden
                    className="absolute top-1 h-3 rounded-sm"
                    style={{
                      left: `${left}%`,
                      width: `max(2px, ${width}%)`,
                      background: error
                        ? `${HATCH}, var(--oh-critical)`
                        : seriesVar(colors.colorFor(n.row.service)),
                      outline: error ? '2px solid var(--oh-critical)' : undefined,
                      outlineOffset: error ? '0' : undefined,
                    }}
                  />
                  <span
                    className="absolute top-0 font-mono text-xs tabular-nums"
                    style={
                      left > 70
                        ? { right: `${100 - left}%`, paddingRight: 4 }
                        : { left: `${left + width}%`, paddingLeft: 4 }
                    }
                  >
                    {formatDuration(n.row.durationNs)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
