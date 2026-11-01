import type { JSHandle, Locator, Page } from '@playwright/test';

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

/** A drawn line spans at least this many px; dots, rings and the marker are far narrower. */
export const LINE_MIN_PX = 40;

/**
 * The widest horizontal run, in CSS px, of plot columns holding a strongly coloured pixel: a drawn series line. Grid
 * lines, axes and labels are grey, an exemplar ring is ~12 px and an isolated point's dot 6 px, so a run of tens of
 * px means the chart drew a line through consecutive points. Read straight from ECharts' canvas.
 */
export async function lineRunPx(chart: Locator, opts: { legend?: boolean } = {}): Promise<number> {
  return chart.evaluate(
    (host, { plot, top }) => {
      const canvas = host.querySelector('canvas');
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) throw new Error('the chart has no 2d canvas');
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      const x0 = Math.round(plot.left * ratio);
      const x1 = canvas.width - Math.round(plot.right * ratio);
      // From below the legend strip, so a legend swatch is never taken for a drawn line.
      const y0 = Math.round(top * ratio);
      const y1 = canvas.height - Math.round(plot.bottom * ratio);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let best = 0;
      let run = 0;
      for (let x = x0; x < x1; x++) {
        let coloured = false;
        for (let y = y0; y < y1 && !coloured; y++) {
          const i = (y * canvas.width + x) * 4;
          const [r = 0, g = 0, b = 0, a = 0] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
          coloured = a > 128 && Math.max(r, g, b) - Math.min(r, g, b) > 80;
        }
        run = coloured ? run + 1 : 0;
        best = Math.max(best, run);
      }
      return best / ratio;
    },
    { plot: PLOT, top: opts.legend === true ? PLOT_TOP.legend : PLOT_TOP.plain },
  );
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

/** The parts of an ECharts instance a run chart spec reads. */
interface LiveChart {
  getOption(): RawOption;
  convertToPixel(finder: { xAxisIndex: number; yAxisIndex: number }, value: number[]): number[];
  getZr(): { storage: { getDisplayList(): DisplayEl[] } };
  getDom(): HTMLElement;
}
interface DisplayEl {
  style?: { text?: unknown };
  transform?: number[] | null;
  invisible?: boolean;
  getBoundingRect(): { x: number; y: number; width: number; height: number };
}
interface RawOption {
  grid: { left: number; top: number; width: number; height: number }[];
  yAxis: { max: number }[];
  dataZoom: { type: string; startValue?: number; endValue?: number }[];
  series: {
    id: string;
    name: string;
    xAxisIndex: number;
    yAxisIndex: number;
    data: { value: [number, number] }[];
    lineStyle?: { color?: string; type?: unknown };
    markLine?: { data?: unknown[] };
  }[];
}

/**
 * The live instance behind a `Chart`'s host element. The viewer exposes none and a real pointer can't read an option,
 * so this walks React's fiber from the host up to the component whose ref holds the instance.
 */
function liveChart(host: Locator): Promise<JSHandle<LiveChart>> {
  return host.evaluateHandle((el): LiveChart => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    type Hook = { memoizedState?: { current?: { getOption?: unknown } }; next?: Hook | null };
    type Fiber = { return?: Fiber | null; memoizedState?: Hook | null };
    let fiber = key === undefined ? null : (el as unknown as Record<string, Fiber>)[key];
    for (; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const current = hook.memoizedState?.current;
        if (typeof current?.getOption === 'function') return current as unknown as LiveChart;
      }
    }
    throw new Error('no ECharts instance above this element');
  });
}

export interface RunChartRead {
  grids: { left: number; top: number; width: number; height: number }[];
  yMax: number[];
  zoom: { startValue: number; endValue: number };
  lines: { name: string; plot: number; xs: number[]; color: unknown }[];
  /** How many plots draw a guide. */
  guides: number;
}

/** A run chart's current option, as far as the specs care. */
export async function readRunChart(host: Locator): Promise<RunChartRead> {
  return (await liveChart(host)).evaluate((c) => {
    const o = c.getOption();
    const zoom = o.dataZoom[0];
    const series = o.series.filter((s) => s.id.startsWith('line:'));
    return {
      grids: o.grid.map(({ left, top, width, height }) => ({ left, top, width, height })),
      yMax: o.yAxis.map((a) => a.max),
      zoom: { startValue: zoom?.startValue ?? Number.NaN, endValue: zoom?.endValue ?? Number.NaN },
      lines: series.map((s) => ({
        name: s.name,
        plot: s.xAxisIndex,
        xs: s.data.map((d) => d.value[0]),
        color: [s.lineStyle?.color, s.lineStyle?.type],
      })),
      guides: o.series.filter((s) => s.id.startsWith('guide') && (s.markLine?.data?.length ?? 0) > 0).length,
    };
  });
}

/** The page position of a line's dot in one run. */
export async function runDot(host: Locator, line: string, run: number): Promise<{ x: number; y: number }> {
  return (await liveChart(host)).evaluate(
    (c, a) => {
      const s = c.getOption().series.find((x) => x.name === a.line);
      const value = s?.data[a.run]?.value;
      if (s === undefined || value === undefined) throw new Error(`no dot for ${a.line} in run ${a.run}`);
      const [x = 0, y = 0] = c.convertToPixel({ xAxisIndex: s.xAxisIndex, yAxisIndex: s.yAxisIndex }, value);
      const r = c.getDom().getBoundingClientRect();
      return { x: r.left + x, y: r.top + y };
    },
    { line, run },
  );
}

/** Every line of text ECharts drew, with its box in px from the chart's top-left corner. */
export async function drawnTexts(
  host: Locator,
): Promise<{ text: string; left: number; right: number; top: number; bottom: number }[]> {
  return (await liveChart(host)).evaluate((c) =>
    c
      .getZr()
      .storage.getDisplayList()
      .flatMap((el) => {
        const text = el.style?.text;
        if (typeof text !== 'string' || text === '' || el.invisible === true) return [];
        const r = el.getBoundingRect();
        const [a = 1, , , d = 1, e = 0, f = 0] = el.transform ?? [];
        return [
          {
            text,
            left: a * r.x + e,
            right: a * (r.x + r.width) + e,
            top: d * r.y + f,
            bottom: d * (r.y + r.height) + f,
          },
        ];
      }),
  );
}

/** A canvas pixel's opacity-sensitive colour at a page position, for what a blur or a highlight did there. */
export async function pixelAt(host: Locator, at: { x: number; y: number }): Promise<number[]> {
  return host.evaluate((el, p) => {
    const canvas = el.querySelector('canvas');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) throw new Error('the chart has no 2d canvas');
    const r = canvas.getBoundingClientRect();
    const ratio = canvas.width / r.width;
    return [
      ...ctx.getImageData(Math.round((p.x - r.left) * ratio), Math.round((p.y - r.top) * ratio), 1, 1).data,
    ];
  }, at);
}

/** The cursor ECharts shows over a chart: it sets it on the canvas's parent. */
export const chartCursor = (host: Locator): Promise<string> =>
  host.evaluate((el) => el.querySelector('canvas')?.parentElement?.style.cursor ?? '');
