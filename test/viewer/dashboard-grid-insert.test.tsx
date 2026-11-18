import { cleanup, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

interface Item {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  static: boolean;
}
const grid = vi.hoisted((): { layout: Item[] } => ({ layout: [] }));
vi.mock('react-grid-layout', () => ({
  default: (p: { layout: Item[]; children: React.ReactNode }): JSX.Element => {
    grid.layout = p.layout;
    return <div data-testid="rgl">{p.children}</div>;
  },
  useContainerWidth: () => ({ width: 1200, containerRef: { current: null }, mounted: true }),
}));

import { DashboardSchema, type Widget } from '../../src/dashboards/schema.js';
import { DashboardGrid, RUN_PANE_ID } from '../../src/viewer/dashboards/grid.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  grid.layout = [];
});

const widgets: readonly Widget[] = DashboardSchema.parse({
  id: 'd',
  title: 'D',
  widgets: [
    { id: 'top', type: 'timeline', x: 0, y: 0, w: 12, h: 6 },
    { id: 'src', type: 'timeline', x: 0, y: 31, w: 12, h: 12 },
    { id: 'below', type: 'logs', x: 0, y: 43, w: 6, h: 8 },
    { id: 'beside', type: 'logs', x: 6, y: 43, w: 6, h: 8 },
  ],
}).widgets;

function mount(editing: boolean, rows = 9): void {
  render(
    <DashboardGrid
      widgets={widgets}
      layout={widgets.map(({ x, y, w, h }) => ({ x, y, w, h }))}
      editing={editing}
      onLayout={() => undefined}
      render={(w) => <p data-testid="w">{w.id}</p>}
      insert={{ after: 'src', rows, render: (px) => <p data-testid="pane">{`pane ${px}px`}</p> }}
    />,
  );
}

test('the pane lands under the source row and the widgets at or below move down by its rows', () => {
  mount(false);
  const at = (id: string): Item | undefined => grid.layout.find((l) => l.i === id);
  expect(at(RUN_PANE_ID)).toMatchObject({ x: 0, y: 43, w: 12, h: 9, static: true });
  expect(at('below')?.y).toBe(43 + 9);
  expect(at('beside')?.y).toBe(43 + 9);
  expect(at('top')?.y).toBe(0);
  expect(at('src')?.y).toBe(31);
  expect(screen.getByTestId('pane').textContent).toBe('pane 260px');
});

test('a widget beside the source that reaches lower pushes the pane lower', () => {
  const wide = DashboardSchema.parse({
    id: 'd',
    title: 'D',
    widgets: [
      { id: 'src', type: 'timeline', x: 0, y: 0, w: 6, h: 4 },
      { id: 'tall', type: 'logs', x: 6, y: 2, w: 6, h: 10 },
      { id: 'next', type: 'logs', x: 0, y: 12, w: 12, h: 4 },
    ],
  }).widgets;
  render(
    <DashboardGrid
      widgets={wide}
      layout={wide.map(({ x, y, w, h }) => ({ x, y, w, h }))}
      editing={false}
      onLayout={() => undefined}
      render={(w) => <p>{w.id}</p>}
      insert={{ after: 'src', rows: 5, render: () => <p>pane</p> }}
    />,
  );
  expect(grid.layout.find((l) => l.i === RUN_PANE_ID)?.y).toBe(12);
  expect(grid.layout.find((l) => l.i === 'next')?.y).toBe(17);
});

test('edit mode ignores the insert', () => {
  mount(true);
  expect(screen.queryByTestId('pane')).toBeNull();
  expect(grid.layout.find((l) => l.i === 'below')?.y).toBe(43);
});

test('stacked, the pane is next after the source', () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  mount(false);
  const order = [...document.querySelectorAll('[data-testid]')].map((e) => e.textContent);
  expect(order.filter((t) => t !== '')).toEqual(['top', 'src', 'pane 260px', 'below', 'beside']);
});

test('stacked, the pane goes after the pair that holds its source (R26)', () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  const small: readonly Widget[] = DashboardSchema.parse({
    id: 'd',
    title: 'D',
    widgets: [
      { id: 'a', type: 'timeline', x: 0, y: 0, w: 2, h: 4 },
      { id: 'b', type: 'timeline', x: 2, y: 0, w: 2, h: 4 },
      { id: 'c', type: 'timeline', x: 0, y: 5, w: 12, h: 4 },
    ],
  }).widgets;
  render(
    <DashboardGrid
      widgets={small}
      layout={small.map(({ x, y, w, h }) => ({ x, y, w, h }))}
      editing={false}
      onLayout={() => undefined}
      render={(w) => <p data-testid="w">{w.id}</p>}
      insert={{ after: 'a', rows: 5, render: () => <p data-testid="w">pane</p> }}
    />,
  );
  expect(screen.getAllByTestId('w').map((e) => e.textContent)).toEqual(['a', 'b', 'pane', 'c']);
});
