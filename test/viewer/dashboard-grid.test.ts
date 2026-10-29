import { expect, test } from 'vitest';
import { DashboardSchema, GRID_COLUMNS, WIDGET_MAX_H, WIDGET_MIN_H } from '../../src/dashboards/schema.js';
import { layoutItem } from '../../src/viewer/dashboards/grid.js';

test('layout items carry the schema bounds, so an edited layout stays valid', () => {
  const item = layoutItem('w1', { x: 2, y: 0, w: 4, h: 6 }, true);
  expect(item).toMatchObject({ minH: WIDGET_MIN_H, maxH: WIDGET_MAX_H, minW: 1, maxW: GRID_COLUMNS });
  expect(item.static).toBe(false);
  expect(layoutItem('w1', { x: 0, y: 0, w: 1, h: 2 }, false).static).toBe(true);
});

test('the bounds are the ones the schema enforces', () => {
  const widget = (h: number) => ({ type: 'timeline', x: 0, y: 0, w: 12, h });
  const parse = (h: number) =>
    DashboardSchema.safeParse({ id: 'd', title: 'D', widgets: [widget(h)] }).success;
  expect([
    parse(WIDGET_MIN_H - 1),
    parse(WIDGET_MIN_H),
    parse(WIDGET_MAX_H),
    parse(WIDGET_MAX_H + 1),
  ]).toEqual([false, true, true, false]);
});
