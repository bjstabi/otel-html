import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DashboardSchema, type Widget } from '../../src/dashboards/schema.js';
import { DashboardGrid } from '../../src/viewer/dashboards/grid.js';

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function spans(ws: { w: number }[]): string[] {
  const widgets: readonly Widget[] = DashboardSchema.parse({
    id: 'd',
    title: 'D',
    widgets: ws.map((w, i) => ({ id: `w${i}`, type: 'timeline', x: 0, y: i * 4, w: w.w, h: 4 })),
  }).widgets;
  render(
    <DashboardGrid
      widgets={widgets}
      layout={widgets.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h }))}
      editing={false}
      onLayout={() => undefined}
      render={(w) => <span data-testid="cell">{w.id}</span>}
    />,
  );
  return screen.getAllByTestId('cell').map((c) => c.parentElement?.style.gridColumn ?? '');
}

test('small widgets pair up, a wide one takes a full row', () => {
  expect(spans([2, 2, 2, 2, 2, 2, 12].map((w) => ({ w })))).toEqual([
    'span 1',
    'span 1',
    'span 1',
    'span 1',
    'span 1',
    'span 1',
    'span 2',
  ]);
});

test('a lone w: 3 widget between two w: 12 widgets takes a full row', () => {
  expect(spans([12, 3, 12].map((w) => ({ w })))).toEqual(['span 2', 'span 2', 'span 2']);
});

test('the odd one out of a run of small widgets takes a full row', () => {
  expect(spans([3, 3, 3, 12].map((w) => ({ w })))).toEqual(['span 1', 'span 1', 'span 2', 'span 2']);
});
