import ReactGridLayout, { useContainerWidth } from 'react-grid-layout';
import { getCompactor, type LayoutItem } from 'react-grid-layout/core';
import 'react-grid-layout/css/styles.css';
import { type JSX, useEffect, useState } from 'react';
import {
  GRID_COLUMNS,
  WIDGET_MAX_H,
  WIDGET_MIN_H,
  WIDGET_MIN_W,
  type Widget,
  type WidgetLayout,
} from '../../dashboards/schema.js';

const ROW_PX = 20;
const GAP_PX = 10;
/** Below this width the widgets stack in one column. */
const STACK_BELOW_PX = 768;

/** A widget of `h` grid rows is this tall: the rows plus the gaps between them. */
export function widgetHeightPx(h: number): number {
  return h * ROW_PX + (h - 1) * GAP_PX;
}

/** Positions are kept exactly as given (no pull-up), and a drag onto another widget is refused, never pushed through it. */
const COMPACTOR = getCompactor(null, false, true);

/** Whether the viewport is narrower than the stacking breakpoint; false where `matchMedia` is missing. */
export function useStacked(): boolean {
  const query = `(max-width: ${STACK_BELOW_PX - 1}px)`;
  const [stacked, setStacked] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = (): void => setStacked(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return stacked;
}

/** Reading order: top to bottom, then left to right. */
function byPosition(a: WidgetLayout, b: WidgetLayout): number {
  return a.y - b.y || a.x - b.x;
}

/** A widget this narrow (or narrower) shares a stacked row with its neighbour. */
const SMALL_W = 3;

/** Column spans (of two) for stacked widgets in reading order: small ones pair up, an unpaired or wide one takes the row. */
function stackedSpans(widths: readonly number[]): number[] {
  const spans = widths.map(() => 2);
  let run = 0;
  widths.forEach((w, i) => {
    if (w > SMALL_W) {
      run = 0;
      return;
    }
    run += 1;
    if (run % 2 === 0) {
      spans[i] = 1;
      spans[i - 1] = 1;
    }
  });
  return spans;
}

/** Whether `spans[i]` is the second of a stacked pair. */
function pairedBefore(spans: readonly number[], i: number): boolean {
  let run = 0;
  for (let k = i - 1; k >= 0 && spans[k] === 1; k--) run++;
  return run % 2 === 1;
}

/** One grid item: the widget's place and the bounds that keep a resized layout valid for the config schema. */
export function layoutItem(id: string, at: WidgetLayout, editing: boolean): LayoutItem {
  return {
    i: id,
    x: at.x,
    y: at.y,
    w: at.w,
    h: at.h,
    minW: WIDGET_MIN_W,
    maxW: GRID_COLUMNS,
    minH: WIDGET_MIN_H,
    maxH: WIDGET_MAX_H,
    static: !editing,
  };
}

/** The grid item id of the inserted pane. */
export const RUN_PANE_ID = 'oh-run-pane';

/** A full-width item put under the row of widget `after`, which pushes the rows below it down by `rows`. */
interface GridInsert {
  after: string;
  /** Grid rows the pane takes. */
  rows: number;
  render(heightPx: number): JSX.Element;
}

/**
 * Where the pane goes: at the largest bottom among the widgets whose vertical span overlaps the source's. The widgets
 * at or below that line move down by `rows`, and one that crosses the line moves to just under the pane. Null when `after` is not a widget.
 */
function placeInsert(
  widgets: readonly Widget[],
  layout: readonly WidgetLayout[],
  insert: Pick<GridInsert, 'after' | 'rows'>,
): { y: number; layout: WidgetLayout[] } | null {
  const at = widgets.findIndex((w) => w.id === insert.after);
  const src = layout[at];
  if (src === undefined) return null;
  const y = Math.max(...layout.filter((l) => l.y < src.y + src.h && src.y < l.y + l.h).map((l) => l.y + l.h));
  // a widget that starts above the line and ends below it (beside the source, not overlapping its span) goes under the pane
  const moved = (l: WidgetLayout): WidgetLayout =>
    l.y >= y ? { ...l, y: l.y + insert.rows } : l.y + l.h > y ? { ...l, y: y + insert.rows } : l;
  return { y, layout: layout.map(moved) };
}

export interface DashboardGridProps {
  widgets: readonly Widget[];
  /** `layout[i]` is the position of `widgets[i]`. */
  layout: readonly WidgetLayout[];
  editing: boolean;
  /** The layout after a drag or resize ends, in `widgets` order. */
  onLayout(layout: WidgetLayout[]): void;
  render(widget: Widget, heightPx: number): JSX.Element;
  /** A pane between rows (the open run); ignored while editing. */
  insert?: GridInsert;
}

/** The 12-column grid (20 px rows, 10 px gaps); a vertical stack on narrow screens, where layout editing is off. */
export function DashboardGrid(props: DashboardGridProps): JSX.Element {
  const { widgets, layout, editing, onLayout, render } = props;
  const insert = editing ? undefined : props.insert;
  const stacked = useStacked();
  const { width, containerRef, mounted } = useContainerWidth();
  const base = widgets.map((widget, i) => ({ widget, at: layout[i] ?? widget }));
  const put =
    insert === undefined
      ? null
      : placeInsert(
          widgets,
          base.map(({ at }) => at),
          insert,
        );
  const placed = put === null ? base : base.map((p, i) => ({ ...p, at: put.layout[i] ?? p.at }));

  if (stacked) {
    const ordered = [...placed].sort((a, b) => byPosition(a.at, b.at));
    const spans = stackedSpans(ordered.map(({ at }) => at.w));
    const source = insert === undefined ? -1 : ordered.findIndex(({ widget }) => widget.id === insert.after);
    // the pane follows the whole stacked row that holds its source: a pair stays together
    const paneAfter =
      source === -1
        ? -1
        : spans[source] === 1 && spans[source + 1] === 1 && !pairedBefore(spans, source)
          ? source + 1
          : source;
    return (
      <div className="grid grid-cols-2 gap-2.5">
        {ordered.flatMap(({ widget, at }, i) => [
          <div key={widget.id} style={{ height: widgetHeightPx(at.h), gridColumn: `span ${spans[i] ?? 2}` }}>
            {render(widget, widgetHeightPx(at.h))}
          </div>,
          ...(insert !== undefined && i === paneAfter
            ? [
                <div key={RUN_PANE_ID} style={{ gridColumn: 'span 2' }}>
                  {insert.render(widgetHeightPx(insert.rows))}
                </div>,
              ]
            : []),
        ])}
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={[
            ...placed.map(({ widget, at }) => layoutItem(widget.id, at, editing)),
            ...(insert === undefined || put === null
              ? []
              : [layoutItem(RUN_PANE_ID, { x: 0, y: put.y, w: GRID_COLUMNS, h: insert.rows }, false)]),
          ]}
          gridConfig={{
            cols: GRID_COLUMNS,
            rowHeight: ROW_PX,
            margin: [GAP_PX, GAP_PX],
            containerPadding: [0, 0],
          }}
          dragConfig={{ enabled: editing, handle: '.oh-drag-handle' }}
          resizeConfig={{ enabled: editing }}
          compactor={COMPACTOR}
          onDragStop={(next) => onLayout(reorder(widgets, next))}
          onResizeStop={(next) => onLayout(reorder(widgets, next))}
        >
          {placed.map(({ widget, at }) => (
            <div key={widget.id}>{render(widget, widgetHeightPx(at.h))}</div>
          ))}
          {insert !== undefined && put !== null && (
            <div key={RUN_PANE_ID}>{insert.render(widgetHeightPx(insert.rows))}</div>
          )}
        </ReactGridLayout>
      )}
    </div>
  );
}

/** The grid's items back in `widgets` order. An item the grid dropped keeps its previous place via the caller. */
function reorder(
  widgets: readonly Widget[],
  next: readonly { i: string; x: number; y: number; w: number; h: number }[],
): WidgetLayout[] {
  return widgets.map((w) => {
    const item = next.find((n) => n.i === w.id);
    return item === undefined
      ? { x: w.x, y: w.y, w: w.w, h: w.h }
      : { x: item.x, y: item.y, w: item.w, h: item.h };
  });
}
