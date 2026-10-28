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

export interface DashboardGridProps {
  widgets: readonly Widget[];
  /** `layout[i]` is the position of `widgets[i]`. */
  layout: readonly WidgetLayout[];
  editing: boolean;
  /** The layout after a drag or resize ends, in `widgets` order. */
  onLayout(layout: WidgetLayout[]): void;
  render(widget: Widget, heightPx: number): JSX.Element;
}

/** The 12-column grid (20 px rows, 10 px gaps); a vertical stack on narrow screens, where layout editing is off. */
export function DashboardGrid(props: DashboardGridProps): JSX.Element {
  const { widgets, layout, editing, onLayout, render } = props;
  const stacked = useStacked();
  const { width, containerRef, mounted } = useContainerWidth();
  const placed = widgets.map((widget, i) => ({ widget, at: layout[i] ?? widget }));

  if (stacked) {
    return (
      <div className="flex flex-col gap-2.5">
        {[...placed]
          .sort((a, b) => byPosition(a.at, b.at))
          .map(({ widget, at }) => (
            <div key={widget.id} style={{ height: widgetHeightPx(at.h) }}>
              {render(widget, widgetHeightPx(at.h))}
            </div>
          ))}
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={placed.map(({ widget, at }) => layoutItem(widget.id, at, editing))}
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
