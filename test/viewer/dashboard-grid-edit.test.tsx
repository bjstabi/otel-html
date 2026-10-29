import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

interface GridProps {
  layout: {
    i: string;
    x: number;
    y: number;
    w: number;
    h: number;
    minH: number;
    maxH: number;
    static: boolean;
  }[];
  dragConfig: { enabled: boolean };
  resizeConfig: { enabled: boolean };
  onDragStop(next: GridProps['layout']): void;
  onResizeStop(next: GridProps['layout']): void;
  children: React.ReactNode;
}
/** The last props react-grid-layout got, so a test can end a drag or resize the way the grid would. */
const grid = vi.hoisted((): { props: GridProps | null } => ({ props: null }));
vi.mock('react-grid-layout', () => ({
  default: (p: GridProps): React.JSX.Element => {
    grid.props = p;
    return <div data-testid="rgl">{p.children}</div>;
  },
  useContainerWidth: () => ({ width: 1200, containerRef: { current: null }, mounted: true }),
}));

import { DashboardSchema, type Widget, type WidgetLayout } from '../../src/dashboards/schema.js';
import { DashboardGrid } from '../../src/viewer/dashboards/grid.js';

afterEach(() => {
  cleanup();
  grid.props = null;
});

const widgets: readonly Widget[] = DashboardSchema.parse({
  id: 'd',
  title: 'D',
  widgets: [
    { id: 'a', type: 'timeline', x: 0, y: 0, w: 6, h: 4 },
    { id: 'b', type: 'logs', x: 6, y: 0, w: 6, h: 4 },
  ],
}).widgets;

function mount(editing: boolean): WidgetLayout[][] {
  const seen: WidgetLayout[][] = [];
  render(
    <DashboardGrid
      widgets={widgets}
      layout={widgets.map(({ x, y, w, h }) => ({ x, y, w, h }))}
      editing={editing}
      onLayout={(l) => seen.push(l)}
      render={(w, px) => <p>{`${w.id} ${px}px`}</p>}
    />,
  );
  return seen;
}

const props = (): GridProps => {
  if (grid.props === null) throw new Error('the grid did not render');
  return grid.props;
};

test('editing turns on drag and resize; the items carry the h bounds', () => {
  mount(true);
  expect(props().dragConfig.enabled).toBe(true);
  expect(props().resizeConfig.enabled).toBe(true);
  expect(props().layout.map((i) => [i.i, i.minH, i.maxH, i.static])).toEqual([
    ['a', 2, 40, false],
    ['b', 2, 40, false],
  ]);
  cleanup();
  mount(false);
  expect(props().dragConfig.enabled).toBe(false);
  expect(props().layout.every((i) => i.static)).toBe(true);
});

test('a drag or resize reports the layout in widget order, whatever order the grid gives', () => {
  const seen = mount(true);
  const moved = [
    { ...props().layout[1], i: 'b', x: 0, y: 4, w: 12, h: 6 },
    { ...props().layout[0], i: 'a', x: 0, y: 0, w: 12, h: 4 },
  ] as GridProps['layout'];
  props().onDragStop(moved);
  props().onResizeStop([{ ...moved[1], h: 8 } as GridProps['layout'][number]]);
  expect(seen).toEqual([
    [
      { x: 0, y: 0, w: 12, h: 4 },
      { x: 0, y: 4, w: 12, h: 6 },
    ],
    // An item the grid left out keeps its place.
    [
      { x: 0, y: 0, w: 12, h: 8 },
      { x: 6, y: 0, w: 6, h: 4 },
    ],
  ]);
});

test('each widget renders at its height in pixels', () => {
  mount(false);
  expect(screen.getByText('a 110px')).toBeTruthy();
});
