import type { Locator, Page } from '@playwright/test';

/** The chart card's plot grid inside its canvas (`GRID` in metric-chart-option.ts); a legend (2+ series) sits above it. */
const PLOT = { left: 56, right: 12, bottom: 24 } as const;
const PLOT_TOP = { legend: 28, plain: 12 } as const;
/** Sweep step in px, below an exemplar ring's ~9 px diameter so none is skipped. */
const STEP_PX = 3;

/**
 * Where the exemplar rings of a chart card are, in px from the chart's top-left corner. The chart is a canvas, so the
 * rings are found the way a pointer finds them: ECharts shows a pointer cursor over a hoverable symbol, and line
 * series draw none (`showSymbol: false`), so every pointer spot inside the plot is an exemplar ring. Neighbouring
 * spots are merged into one ring each.
 */
export async function exemplarRings(
  chart: Locator,
  opts: { legend: boolean },
): Promise<{ x: number; y: number }[]> {
  const spots = await chart.evaluate(
    (host, { plot, top, step }) => {
      const canvas = host.querySelector('canvas');
      const root = canvas?.parentElement;
      if (!canvas || !root) throw new Error('the chart has no canvas');
      const r = canvas.getBoundingClientRect();
      const out: [number, number][] = [];
      for (let y = top; y < r.height - plot.bottom; y += step)
        for (let x = plot.left; x < r.width - plot.right; x += step) {
          canvas.dispatchEvent(
            new MouseEvent('mousemove', { bubbles: true, clientX: r.left + x, clientY: r.top + y }),
          );
          if (root.style.cursor === 'pointer') out.push([x, y]);
        }
      canvas.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      return out;
    },
    { plot: PLOT, top: opts.legend ? PLOT_TOP.legend : PLOT_TOP.plain, step: STEP_PX },
  );
  const rings: { x: number; y: number; n: number }[] = [];
  for (const [x, y] of spots) {
    const near = rings.find((g) => Math.hypot(g.x / g.n - x, g.y / g.n - y) <= 4 * STEP_PX);
    if (near === undefined) rings.push({ x, y, n: 1 });
    else {
      near.x += x;
      near.y += y;
      near.n += 1;
    }
  }
  return rings.map((g) => ({ x: g.x / g.n, y: g.y / g.n }));
}

/** Clicks the chart at (x, y) px from its top-left corner and returns the click menu's item texts. */
export async function menuAt(page: Page, chart: Locator, at: { x: number; y: number }): Promise<string[]> {
  await chart.click({ position: at });
  const items = page.getByRole('menuitem');
  await items.first().waitFor();
  return (await items.allTextContents()).map((s) => s.trim());
}

/** Collects console errors, page errors and dialogs; a spec ends with `expect(problems).toEqual([])`. */
export function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('dialog', (d) => {
    problems.push(`unexpected dialog: ${d.message()}`);
    void d.dismiss();
  });
  return problems;
}
