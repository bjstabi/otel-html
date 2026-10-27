// biome-ignore-all lint/a11y/useSemanticElements: a virtualized grid positions rows absolutely, which real <table> elements cannot do; the ARIA table roles carry the semantics
// biome-ignore-all lint/a11y/useFocusableInteractive: header cells hold a focusable sort button; rows are focusable via roving tabindex
import { type ColumnDef, tableFeatures, useTable } from '@tanstack/react-table';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { type JSX, type KeyboardEvent, useEffect, useMemo, useRef } from 'react';
import type { UnixNanos } from '../../model/ids.js';
import { MOVE_EVENT } from '../shell/move-event.js';
import { type ColorAssigner, createColorAssigner } from '../theme/palette.js';
import type { ColumnUi } from '../traces/columns.js';

export interface SortState {
  column: string;
  dir: 'asc' | 'desc';
}

export interface ResultsTableProps<R> {
  rows: readonly R[];
  columns: readonly ColumnUi<R>[];
  rowId(row: R): string;
  sort: SortState | null;
  onSort(next: SortState): void;
  onRowClick(row: R): void;
  selectedId: string | null;
  epoch: UnixNanos;
  colors?: ColorAssigner;
  /** Scroll viewport height in px (default 480). */
  height?: number;
  /**
   * Whether this table acts on the shell's j/k move event (default true). Exactly one consumer may act per press:
   * the explorer disables it while the trace panel is open, and embedded tables never consume it.
   */
  moveEnabled?: boolean;
  /** Row height in px (default 36); taller rows suit multi-line cells such as log bodies. */
  rowHeight?: number;
}

/** Default row height in px. */
const ROW_HEIGHT = 36;
const features = tableFeatures({});

/** react-table wants object rows; the wrapper keeps the table generic over any row type. */
interface Entry<R> {
  row: R;
}

/** A hidden or not-yet-laid-out scroller reports 0; render a window of rows instead of none. */
export function rectWithFallback(fallback: number): typeof observeElementRect {
  return (instance, cb) =>
    observeElementRect(instance, (r) => cb(r.height === 0 ? { width: r.width, height: fallback } : r));
}

function nextDir(sort: SortState | null, column: string): SortState['dir'] {
  // First click on a column sorts descending (largest / latest first); a second click flips it.
  return sort?.column === column && sort.dir === 'desc' ? 'asc' : 'desc';
}

/**
 * Virtualized, sortable results grid. Sorting is requested (`onSort`), not applied: the data layer sorts the
 * whole matched set, so the rows arrive already in order. Rows are focusable; arrows move, Enter/Space selects.
 */
export function ResultsTable<R>(props: ResultsTableProps<R>): JSX.Element {
  const { rows, columns, sort, selectedId } = props;
  const height = props.height ?? 480;
  const rowHeight = props.rowHeight ?? ROW_HEIGHT;
  const fallbackColors = useMemo(() => createColorAssigner(), []);
  const ctx = { epoch: props.epoch, colors: props.colors ?? fallbackColors };
  const scroller = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);

  const defs = useMemo<ColumnDef<typeof features, Entry<R>>[]>(
    () => columns.map((c) => ({ id: c.id, header: c.header, size: c.width })),
    [columns],
  );
  const data = useMemo(() => rows.map((row): Entry<R> => ({ row })), [rows]);
  const table = useTable({ features, columns: defs, data });
  const modelRows = table.getRowModel().rows;
  const template = columns.map((c) => `minmax(0, ${c.width}fr)`).join(' ');

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    initialRect: { width: 0, height },
    observeElementRect: rectWithFallback(height),
  });

  const latest = useRef({ rows, selectedId, props });
  latest.current = { rows, selectedId, props };

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

  const moveEnabled = props.moveEnabled ?? true;

  // Keep the selected row in view when the selection changes from elsewhere (the trace panel's j/k).
  const selectedAt = selectedId === null ? -1 : rows.findIndex((r) => props.rowId(r) === selectedId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when the selected row changes
  useEffect(() => {
    if (selectedAt >= 0) virtual.scrollToIndex(selectedAt);
  }, [selectedId]);

  // j/k from the shell: move the selection one row, keeping keyboard focus where it was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the handler reads everything through `latest`
  useEffect(() => {
    if (!moveEnabled) return;
    const onMove = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      const delta: unknown = e.detail;
      if (delta !== 1 && delta !== -1) return;
      const { rows: current, selectedId: sel, props: p } = latest.current;
      if (current.length === 0) return;
      const at = sel === null ? -1 : current.findIndex((r) => p.rowId(r) === sel);
      const next = Math.min(
        current.length - 1,
        Math.max(0, at === -1 ? (delta === 1 ? 0 : current.length - 1) : at + delta),
      );
      const target = current[next];
      if (target === undefined) return;
      const hadFocus = scroller.current?.contains(document.activeElement) === true;
      p.onRowClick(target);
      if (hadFocus) focusIndex(next);
      else virtual.scrollToIndex(next);
    };
    window.addEventListener(MOVE_EVENT, onMove);
    return () => window.removeEventListener(MOVE_EVENT, onMove);
  }, [moveEnabled]);

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, index: number): void => {
    const row = rows[index];
    if (row === undefined) return;
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
      case 'Enter':
      case ' ':
        e.preventDefault();
        props.onRowClick(row);
        break;
    }
  };

  const selectedIndex = selectedId === null ? -1 : rows.findIndex((r) => props.rowId(r) === selectedId);
  const tabbable = Math.max(0, selectedIndex);

  return (
    <div
      role="grid"
      aria-label="Results"
      aria-rowcount={rows.length + 1}
      className="overflow-hidden rounded-card border border-hairline bg-surface"
    >
      <div role="rowgroup" className="border-b border-hairline bg-page">
        <div role="row" className="grid items-center gap-2 px-3" style={{ gridTemplateColumns: template }}>
          {columns.map((c) => {
            const active = sort?.column === c.sort ? sort : null;
            const ariaSort =
              c.sort === undefined
                ? undefined
                : active === null
                  ? 'none'
                  : active.dir === 'asc'
                    ? 'ascending'
                    : 'descending';
            return (
              <div
                key={c.id}
                role="columnheader"
                aria-sort={ariaSort}
                className={`py-2 text-xs font-semibold text-ink-2 ${c.mono === true ? 'font-mono' : ''}`}
              >
                {c.sort === undefined ? (
                  c.header
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      c.sort !== undefined && props.onSort({ column: c.sort, dir: nextDir(sort, c.sort) })
                    }
                    className="inline-flex items-center gap-1 rounded-full px-1 hover:bg-hairline"
                  >
                    {c.header}
                    {active === null ? (
                      <ChevronsUpDown size={12} aria-hidden className="text-muted" />
                    ) : active.dir === 'asc' ? (
                      <ArrowUp size={12} aria-hidden />
                    ) : (
                      <ArrowDown size={12} aria-hidden />
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div ref={scroller} role="rowgroup" className="overflow-auto" style={{ height }}>
        <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((v) => {
            const modelRow = modelRows[v.index];
            const row = rows[v.index];
            if (modelRow === undefined || row === undefined) return null;
            const id = props.rowId(row);
            const selected = id === selectedId;
            return (
              <div
                key={modelRow.id}
                role="row"
                data-row-index={v.index}
                aria-rowindex={v.index + 2}
                aria-selected={selected}
                data-selected={selected ? 'true' : undefined}
                tabIndex={v.index === tabbable ? 0 : -1}
                onClick={() => props.onRowClick(row)}
                onKeyDown={(e) => onRowKey(e, v.index)}
                className={`absolute left-0 grid w-full cursor-pointer items-center gap-2 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  selected ? 'bg-ink text-surface' : 'hover:bg-page'
                }`}
                style={{
                  top: 0,
                  height: rowHeight,
                  transform: `translateY(${v.start}px)`,
                  gridTemplateColumns: template,
                }}
              >
                {columns.map((c) => (
                  <div
                    key={c.id}
                    role="gridcell"
                    className={`min-w-0 truncate ${c.mono === true ? 'font-mono text-xs tabular-nums' : ''}`}
                  >
                    {c.cell(row, ctx)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
