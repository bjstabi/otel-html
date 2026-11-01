import { describe, expect, test } from 'vitest';
import { type PlotRect, plotRects } from '../../src/viewer/components/run-chart-layout.js';

const base = { width: 1000, height: 500, split: true, slider: true };

function inside(rects: PlotRect[], width: number, height: number): void {
  for (const r of rects) {
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.left + r.width).toBeLessThanOrEqual(width);
    expect(r.top + r.height).toBeLessThanOrEqual(height);
  }
}

const columns = (rects: PlotRect[]): number =>
  new Set(rects.map((r) => r.top)).size === 0 ? 0 : rects.filter((r) => r.top === rects[0]?.top).length;

describe('plotRects', () => {
  test('a single plot grows when the slider is off', () => {
    const on = plotRects({ ...base, plots: 1, split: false });
    const off = plotRects({ ...base, plots: 1, split: false, slider: false });
    expect(on.rects).toHaveLength(1);
    expect(off.rects[0]?.height).toBeGreaterThan(on.rects[0]?.height ?? 0);
    expect(on.rects[0]?.xLabels).toBe(true);
    inside(on.rects, 1000, 500);
    inside(off.rects, 1000, 500);
  });

  test('9 split makes 3 columns with x labels on the last row only', () => {
    const { rects, splitFits } = plotRects({ ...base, plots: 9 });
    expect(splitFits).toBe(true);
    expect(rects).toHaveLength(9);
    expect(columns(rects)).toBe(3);
    expect(rects.map((r) => r.xLabels)).toEqual([false, false, false, false, false, false, true, true, true]);
    inside(rects, 1000, 500);
  });

  test('4 split makes 2 columns, each larger than in the 9 case', () => {
    const four = plotRects({ ...base, plots: 4 });
    const nine = plotRects({ ...base, plots: 9 });
    expect(columns(four.rects)).toBe(2);
    expect(four.rects[0]?.width).toBeGreaterThan(nine.rects[0]?.width ?? 0);
    expect(four.rects[0]?.height).toBeGreaterThan(nine.rects[0]?.height ?? 0);
    inside(four.rects, 1000, 500);
  });

  test('5 split makes 3 columns and a short last row stretches', () => {
    const { rects } = plotRects({ ...base, plots: 5 });
    expect(columns(rects)).toBe(3);
    expect(rects[3]?.width).toBeGreaterThan(rects[0]?.width ?? 0);
    expect(rects[4]?.width).toBeGreaterThan(rects[0]?.width ?? 0);
    inside(rects, 1000, 500);
  });

  test('narrow widths keep each cell at least 230px', () => {
    const { rects } = plotRects({ ...base, width: 500, plots: 9 });
    expect(columns(rects)).toBeLessThanOrEqual(2);
    expect(500 / columns(rects)).toBeGreaterThanOrEqual(230);
    inside(rects, 500, 500);
  });

  test('a split that is too short falls back to one plot', () => {
    const { rects, splitFits } = plotRects({ ...base, height: 200, plots: 9 });
    expect(splitFits).toBe(false);
    expect(rects).toHaveLength(1);
    inside(rects, 1000, 200);
  });

  test('forceSplit keeps the split even when too short', () => {
    const { rects, splitFits } = plotRects({ ...base, height: 200, plots: 9, forceSplit: true });
    expect(splitFits).toBe(true);
    expect(rects).toHaveLength(9);
    inside(rects, 1000, 200);
  });

  test('one line fills the widget when split', () => {
    const one = plotRects({ ...base, plots: 1 });
    const single = plotRects({ ...base, plots: 1, split: false });
    expect(one.rects).toHaveLength(1);
    expect(one.rects[0]?.width).toBeGreaterThan(900 - 80);
    expect(single.rects).toHaveLength(1);
  });
});
