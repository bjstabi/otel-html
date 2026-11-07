import type { Locator, Page } from '@playwright/test';
import { parse } from 'yaml';
import { copied, stubClipboard } from './clipboard.js';
import {
  RUN_CHART_FAILED_JOB,
  RUN_CHART_FAILED_RUN,
  RUN_CHART_HOSTILE_JOB,
  RUN_CHART_JOBS,
  RUN_CHART_OUTLIER_JOB,
  RUN_CHART_RUN_MINUTES,
  RUN_CHART_T0_MS,
  runChartRunId,
} from './fixture.js';
import {
  chartCursor,
  drawnTexts,
  pixelAt,
  type RunChartRead,
  readRunChart,
  runDot,
  watchProblems,
} from './metric-chart.js';
import { expect, HTTP, test } from './test.js';

test.skip(true, 'plan 3: metrics in the format-4 viewer');

test.use({ timezoneId: 'Asia/Tokyo' });

const RUNS = RUN_CHART_RUN_MINUTES.length;
const SLIDER = { bottom: 8, height: 20, right: 16 };
const HANDLE_INSET_PX = 2;
/** Two x labels side by side are this far apart at least, or they read as one. */
const LABEL_GAP_PX = 2;

const card = (page: Page): Locator => page.getByRole('region', { name: /Job duration|duration · avg/ });
const hostOf = (page: Page): Locator => card(page).getByRole('img', { name: /lines over/ });
const toggle = (page: Page, name: string): Locator => card(page).getByRole('button', { name, exact: true });
/** ECharts appends its tooltip beside the canvas's parent. */
const tooltipOf = (host: Locator): Locator => host.locator('> div:not(:has(canvas))');

/**
 * Waits for the chart's box and plots to hold still. Just after opening its width was seen to shrink (686 or 720 px to
 * 666 px), which moved the dots after they were read; what drives that wasn't traced.
 */
async function layoutSettled(page: Page, host: Locator): Promise<void> {
  const layout = async (): Promise<string> => {
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    return JSON.stringify([await host.boundingBox(), (await readRunChart(host)).grids]);
  };
  await expect(async () => expect(await layout()).toBe(await layout())).toPass();
}

async function open(page: Page, reportUrl: (name: 'run-charts') => string, id = 'runs'): Promise<Locator> {
  await page.goto(`${reportUrl('run-charts')}/index.html#/dashboards/${id}`);
  // The variables bar loads after the chart can, and moves it down when it does.
  await expect(page.getByRole('combobox', { name: 'run' })).toBeVisible();
  const host = hostOf(page);
  await expect(host).toBeVisible();
  await expect.poll(async () => (await readRunChart(host)).lines.length).toBeGreaterThan(0);
  await layoutSettled(page, host);
  return host;
}

/** The slider's track in page px. */
async function sliderTrack(host: Locator): Promise<{ left: number; right: number; y: number }> {
  const box = await host.boundingBox();
  const { grids } = await readRunChart(host);
  if (box === null || grids[0] === undefined) throw new Error('the chart is laid out');
  return {
    left: box.x + grids[0].left,
    right: box.x + box.width - SLIDER.right,
    y: box.y + box.height - SLIDER.bottom - SLIDER.height / 2,
  };
}

/** Presses the left handle 2 px inside its edge and moves it to the share `to` of the track, leaving the button down. */
async function grabLeftHandle(page: Page, host: Locator, to: number): Promise<void> {
  const t = await sliderTrack(host);
  await page.mouse.move(t.left + HANDLE_INSET_PX, t.y);
  await page.mouse.down();
  await page.mouse.move(t.left + (t.right - t.left) * to, t.y, { steps: 8 });
}

/** The real-mouse zoom the zoom tests start from: the oldest run, and the outlier in it, out of view. */
async function zoomPastOldest(page: Page, host: Locator): Promise<void> {
  await grabLeftHandle(page, host, 0.3);
  await page.mouse.up();
}

const OPAQUE = 255;
/** The opacity of `lint`'s dot in the second run, off the column of the third-run and later dots the tests hover. */
const alphaOfLint = async (host: Locator): Promise<number> =>
  (await pixelAt(host, await runDot(host, 'lint', 1)))[3] ?? 0;

const maxOfOutlier = (r: RunChartRead): number => {
  const plot = r.lines.find((l) => l.name === RUN_CHART_OUTLIER_JOB)?.plot;
  return r.yMax[plot ?? -1] ?? Number.NaN;
};

/** The indexes of the runs inside the chart's `dataZoom` range, on either x axis. */
const runsInZoom = (r: RunChartRead): number[] => {
  const xs = r.lines[0]?.xs ?? [];
  return xs.flatMap((x, n) => (x >= r.zoom.startValue && x <= r.zoom.endValue ? [n] : []));
};

const expectConfigured = async (page: Page, host: Locator): Promise<void> => {
  await expect(toggle(page, 'Slider')).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(page, 'Even spacing')).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(page, 'Split')).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(page, 'Legend')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await readRunChart(host)).grids.length).toBe(RUN_CHART_JOBS.length);
  const r = await readRunChart(host);
  expect(r.lines).toHaveLength(RUN_CHART_JOBS.length);
  expect(runsInZoom(r)).toEqual([...Array(RUNS).keys()]);
  await expect(toggle(page, 'Reset')).toBeDisabled();
};

test('opens split with the slider and no legend', HTTP, async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  const host = await open(page, reportUrl);
  expect((await readRunChart(host)).grids).toHaveLength(RUN_CHART_JOBS.length);
  await expectConfigured(page, host);
  await expect(card(page).getByRole('list', { name: 'Lines' })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('dragging the slider past the outlier tightens the y axis, and back widens it', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  const host = await open(page, reportUrl);
  const before = maxOfOutlier(await readRunChart(host));

  await grabLeftHandle(page, host, 0.3);
  // The y axis `setOption` has fired with the button still down, and the drag carries on through it.
  await expect.poll(async () => maxOfOutlier(await readRunChart(host))).toBeLessThan(before);
  const t = await sliderTrack(host);
  await page.mouse.move(t.left + (t.right - t.left) * 0.5, t.y, { steps: 4 });
  await expect.poll(async () => runsInZoom(await readRunChart(host))[0]).toBeGreaterThanOrEqual(2);
  await page.mouse.up();
  const tight = maxOfOutlier(await readRunChart(host));
  expect(tight).toBeLessThan(before);

  const now = (await readRunChart(host)).zoom.startValue;
  const from = t.left + ((t.right - t.left) * now) / (RUNS - 1);
  await page.mouse.move(from + HANDLE_INSET_PX, t.y);
  await page.mouse.down();
  await page.mouse.move(t.left, t.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => maxOfOutlier(await readRunChart(host))).toBe(before);
  expect(problems).toEqual([]);
});

test('the slider tightens the y axis on real time too', async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  const before = maxOfOutlier(await readRunChart(host));
  await toggle(page, 'Even spacing').click();
  await expect(toggle(page, 'Even spacing')).toHaveAttribute('aria-pressed', 'false');
  await grabLeftHandle(page, host, 0.03);
  await page.mouse.up();
  await expect.poll(async () => maxOfOutlier(await readRunChart(host))).toBeLessThan(before);
});

test('each toggle fills the space and leaves the widget size alone', async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  const widget = page.locator('[data-widget]').first();
  const size = await widget.boundingBox();
  const area = (r: RunChartRead): number => r.grids.reduce((sum, g) => sum + g.width * g.height, 0);
  for (const name of ['Slider', 'Legend', 'Split']) {
    const before = await readRunChart(host);
    await toggle(page, name).click();
    await expect.poll(async () => (await readRunChart(host)).grids).not.toEqual(before.grids);
    expect(await widget.boundingBox()).toEqual(size);
    if (name === 'Slider') expect(area(await readRunChart(host))).toBeGreaterThan(area(before));
    await toggle(page, name).click();
    await expect.poll(async () => (await readRunChart(host)).grids).toEqual(before.grids);
    expect(await widget.boundingBox()).toEqual(size);
  }
});

test('spacing keeps the same runs in view', async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  await zoomPastOldest(page, host);
  const before = runsInZoom(await readRunChart(host));
  expect(before.length).toBeLessThan(RUNS);
  for (let n = 0; n < 2; n++) {
    await toggle(page, 'Even spacing').click();
    await expect(toggle(page, 'Even spacing')).toHaveAttribute('aria-pressed', n === 0 ? 'false' : 'true');
    await expect.poll(async () => runsInZoom(await readRunChart(host))).toEqual(before);
  }
});

test('tooltip only on a dot', async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  const widget = page.locator('[data-widget]').first();
  const tooltip = tooltipOf(host);
  const dot = await runDot(host, RUN_CHART_OUTLIER_JOB, 1);
  await page.mouse.move(dot.x, dot.y);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(RUN_CHART_OUTLIER_JOB);
  expect(await chartCursor(host)).toBe('pointer');
  await expect.poll(async () => (await readRunChart(host)).guides).toBe(RUN_CHART_JOBS.length);
  const box = await widget.boundingBox();
  const tip = await tooltip.boundingBox();
  if (box === null || tip === null) throw new Error('both are laid out');
  expect(tip.x).toBeGreaterThanOrEqual(box.x);
  expect(tip.y).toBeGreaterThanOrEqual(box.y);
  expect(tip.x + tip.width).toBeLessThanOrEqual(box.x + box.width);
  expect(tip.y + tip.height).toBeLessThanOrEqual(box.y + box.height);

  // Empty plot: well above the line's dots, between two runs.
  const next = await runDot(host, RUN_CHART_OUTLIER_JOB, 2);
  await page.mouse.move((dot.x + next.x) / 2, dot.y - 30);
  await expect(tooltip).toBeHidden();
  expect(await chartCursor(host)).not.toBe('pointer');
});

test('a failed dot says so in its tooltip', async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  const dot = await runDot(host, RUN_CHART_FAILED_JOB, RUN_CHART_FAILED_RUN);
  await page.mouse.move(dot.x, dot.y);
  await expect(tooltipOf(host)).toContainText('failed');
});

test('hovering a dot on one plot dims the other lines, draws the guide and keeps the tooltip', async ({
  page,
  reportUrl,
}) => {
  const host = await open(page, reportUrl);
  await toggle(page, 'Split').click();
  await expect.poll(async () => (await readRunChart(host)).grids.length).toBe(1);
  // In another column from the hovered dot: the guide is opaque and would paint over a dot in the same one.
  const other = await runDot(host, 'lint', 1);
  const rest = await pixelAt(host, other);
  const dot = await runDot(host, RUN_CHART_OUTLIER_JOB, 3);
  await page.mouse.move(dot.x, dot.y);
  await expect.poll(async () => (await readRunChart(host)).guides).toBe(1);
  await expect(tooltipOf(host)).toBeVisible();
  await expect.poll(() => alphaOfLint(host)).toBeLessThan(OPAQUE);
  // Still open and still dim once the guide's `setOption` has drawn and a frame has passed.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(tooltipOf(host)).toBeVisible();
  expect(await alphaOfLint(host)).toBeLessThan(OPAQUE);
  await expect(tooltipOf(host)).toContainText(RUN_CHART_OUTLIER_JOB);

  await page.mouse.move(dot.x + 15, dot.y - 40);
  await expect(tooltipOf(host)).toBeHidden();
  await expect.poll(async () => (await readRunChart(host)).guides).toBe(0);
  await expect.poll(() => pixelAt(host, other)).toEqual(rest);
});

test.describe('a rebuild during a hover on one plot leaves no line dim', () => {
  const rebuilds: Record<
    string,
    (page: Page, host: Locator, dot: { x: number; y: number }) => Promise<void>
  > = {
    'a click on the dot': async (page, _host, dot) => {
      await page.mouse.click(dot.x, dot.y);
      await expect(page.getByRole('combobox', { name: 'run' })).toHaveText(runChartRunId(3));
    },
    'a toggle from the keyboard': async (page) => {
      await page.keyboard.press('Enter');
      await expect(toggle(page, 'Slider')).toHaveAttribute('aria-pressed', 'false');
    },
    'a resize': async (page, host) => {
      const before = (await readRunChart(host)).grids;
      await page.setViewportSize({ width: 1100, height: 720 });
      await expect.poll(async () => (await readRunChart(host)).grids).not.toEqual(before);
    },
    'a theme switch from the keyboard': async (page) => {
      await page.getByRole('button', { name: 'Dark theme' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    },
  };
  for (const [name, rebuild] of Object.entries(rebuilds)) {
    test(name, async ({ page, reportUrl }) => {
      const host = await open(page, reportUrl);
      await toggle(page, 'Split').click();
      await expect.poll(async () => (await readRunChart(host)).grids.length).toBe(1);
      await toggle(page, 'Slider').focus();
      const dot = await runDot(host, RUN_CHART_OUTLIER_JOB, 3);
      await page.mouse.move(dot.x, dot.y);
      await expect.poll(() => alphaOfLint(host)).toBeLessThan(OPAQUE);
      await rebuild(page, host, dot);
      await page.mouse.move(dot.x + 15, dot.y - 40);
      await page.mouse.move(1, 1);
      await expect.poll(() => alphaOfLint(host)).toBe(OPAQUE);
    });
  }

  // The outlier's steep first segment has no other line near it, and a line blurs with no ECharts `mouseover`.
  for (const from of ['directly', 'from a dot']) {
    test(`a keyboard toggle while hovering a line, ${from}`, async ({ page, reportUrl }) => {
      const host = await open(page, reportUrl);
      await toggle(page, 'Split').click();
      await expect.poll(async () => (await readRunChart(host)).grids.length).toBe(1);
      await toggle(page, 'Slider').focus();
      const start = await runDot(host, RUN_CHART_OUTLIER_JOB, 0);
      const end = await runDot(host, RUN_CHART_OUTLIER_JOB, 1);
      if (from === 'from a dot') {
        await page.mouse.move(start.x, start.y);
        await expect(tooltipOf(host)).toBeVisible();
      }
      await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2);
      await expect(tooltipOf(host)).toBeHidden();
      await expect.poll(() => alphaOfLint(host)).toBeLessThan(OPAQUE);
      await page.keyboard.press('Enter');
      await expect(toggle(page, 'Slider')).toHaveAttribute('aria-pressed', 'false');
      await page.mouse.move(1, 1);
      await expect.poll(() => alphaOfLint(host)).toBe(OPAQUE);
    });
  }

  test('hiding a line from its highlighted legend row', async ({ page, reportUrl }) => {
    const host = await open(page, reportUrl);
    await toggle(page, 'Split').click();
    await toggle(page, 'Legend').click();
    await expect.poll(async () => (await readRunChart(host)).grids.length).toBe(1);
    const row = card(page).getByRole('list', { name: 'Lines' }).getByRole('button', { name: /^docs/ });
    await row.hover();
    await expect.poll(() => alphaOfLint(host)).toBeLessThan(OPAQUE);
    await row.click();
    await expect.poll(async () => (await readRunChart(host)).lines.length).toBe(RUN_CHART_JOBS.length - 1);
    await page.mouse.move(1, 1);
    await expect.poll(() => alphaOfLint(host)).toBe(OPAQUE);
  });
});

test('two-line x labels fit, with the slider on and off, on either spacing and when narrow', async ({
  page,
  reportUrl,
}) => {
  const host = await open(page, reportUrl);
  const label = /^(\w{3} \d{1,2}|\d{1,2}:\d{2}.*)$/;
  const fits = async (slider: boolean): Promise<boolean> => {
    const box = await host.boundingBox();
    if (box === null) throw new Error('the chart is laid out');
    const floor = box.height - (slider ? SLIDER.bottom + SLIDER.height : 0);
    const r = await readRunChart(host);
    const plotsEnd = Math.max(...r.grids.map((g) => g.top + g.height));
    const labels = (await drawnTexts(host)).filter((t) => label.test(t.text) && t.top >= plotsEnd);
    const crowded = labels.some((a) =>
      labels.some((b) => a !== b && a.top === b.top && a.left <= b.left && a.right + LABEL_GAP_PX > b.left),
    );
    return (
      labels.length > 0 &&
      !crowded &&
      labels.every((t) => t.bottom <= floor && t.left >= 0 && t.right <= box.width)
    );
  };
  const everySpacing = async (state: string): Promise<void> => {
    for (const spacing of ['even', 'real']) {
      for (const slider of [true, false]) {
        await expect.poll(() => fits(slider), `${state}, ${spacing}, slider ${slider}`).toBe(true);
        await toggle(page, 'Slider').click();
      }
      await toggle(page, 'Even spacing').click();
    }
  };
  await everySpacing('split');
  await toggle(page, 'Split').click();
  await everySpacing('single plot');
  // The labels' tightest case: the time axis's ticks don't thin out as the plot narrows.
  await page.setViewportSize({ width: 800, height: 720 });
  await everySpacing('narrow');
});

test('plain wheel scrolls the page and does not zoom', async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  const before = await readRunChart(host);
  const dot = await runDot(host, RUN_CHART_JOBS[0], 1);
  await page.mouse.move(dot.x, dot.y);
  await page.mouse.wheel(0, 40);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect((await readRunChart(host)).zoom).toEqual(before.zoom);
  await expect(toggle(page, 'Reset')).toBeDisabled();
});

test('ctrl+wheel over a plot zooms, and a drag on the plot does nothing', async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  const dot = await runDot(host, RUN_CHART_JOBS[3], 3);
  await page.mouse.move(dot.x, dot.y);
  await page.mouse.down();
  await page.mouse.move(dot.x - 60, dot.y, { steps: 4 });
  await page.mouse.up();
  await expect(toggle(page, 'Reset')).toBeDisabled();

  await page.mouse.move(dot.x, dot.y);
  await page.keyboard.down('Control');
  // ECharts zooms a step at a time and a category axis rounds to runs, so one notch may not reach a whole run.
  await expect(async () => {
    await page.mouse.wheel(0, -120);
    expect(runsInZoom(await readRunChart(host)).length).toBeLessThan(RUNS);
  }).toPass();
  await page.keyboard.up('Control');
  await expect(toggle(page, 'Reset')).toBeEnabled();
});

test('Reset after a zoom', async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  await zoomPastOldest(page, host);
  await expect(toggle(page, 'Reset')).toBeEnabled();
  await toggle(page, 'Reset').click();
  await expectConfigured(page, host);
  const r = await readRunChart(host);
  expect(r.zoom).toEqual({ startValue: 0, endValue: RUNS - 1 });
});

test('Reset after a hidden line', async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  await toggle(page, 'Legend').click();
  await card(page).getByRole('list', { name: 'Lines' }).getByRole('button', { name: /^lint/ }).click();
  await expect.poll(async () => (await readRunChart(host)).lines.length).toBe(RUN_CHART_JOBS.length - 1);
  // With the toggles back as configured, only the hidden line is left for Reset to undo.
  await toggle(page, 'Legend').click();
  await expect(toggle(page, 'Reset')).toBeEnabled();
  await toggle(page, 'Reset').click();
  await expectConfigured(page, host);
});

test('Reset after a toggle', async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  await toggle(page, 'Even spacing').click();
  await expect(toggle(page, 'Reset')).toBeEnabled();
  await toggle(page, 'Reset').click();
  await expectConfigured(page, host);
});

test('clicking a dot filters to the run and keeps all columns', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  const host = await open(page, reportUrl);
  const before = await readRunChart(host);
  const dot = await runDot(host, RUN_CHART_OUTLIER_JOB, 2);
  await page.mouse.click(dot.x, dot.y);
  await expect(page.getByRole('combobox', { name: 'run' })).toHaveText(runChartRunId(2));
  await expect.poll(async () => (await readRunChart(host)).guides).toBe(RUN_CHART_JOBS.length);
  const after = await readRunChart(host);
  expect(after.lines.map((l) => l.xs)).toEqual(before.lines.map((l) => l.xs));
  expect(problems).toEqual([]);
});

test('a filtered run keeps the zoom, and leaving another dot brings its guide back', async ({
  page,
  reportUrl,
}) => {
  const host = await open(page, reportUrl);
  await zoomPastOldest(page, host);
  const zoomed = runsInZoom(await readRunChart(host));
  const dot = await runDot(host, RUN_CHART_OUTLIER_JOB, 3);
  await page.mouse.click(dot.x, dot.y);
  await expect.poll(async () => (await readRunChart(host)).guides).toBe(RUN_CHART_JOBS.length);
  expect(runsInZoom(await readRunChart(host))).toEqual(zoomed);
  const other = await runDot(host, RUN_CHART_OUTLIER_JOB, 4);
  await page.mouse.move(other.x, other.y);
  await expect(tooltipOf(host)).toBeVisible();
  await page.mouse.move(other.x + 15, other.y - 40);
  await expect(tooltipOf(host)).toBeHidden();
  expect((await readRunChart(host)).guides).toBe(RUN_CHART_JOBS.length);
});

test("the dashboard window's change clears the zoom", async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  await zoomPastOldest(page, host);
  await expect(toggle(page, 'Reset')).toBeEnabled();
  await page.getByRole('button', { name: '1h', exact: true }).click();
  await page.getByRole('button', { name: 'Entire run', exact: true }).click();
  await expectConfigured(page, hostOf(page));
});

test('a line keeps its color when another is hidden, and the legend reads the hovered run', async ({
  page,
  reportUrl,
}) => {
  const host = await open(page, reportUrl);
  await toggle(page, 'Legend').click();
  const legend = card(page).getByRole('list', { name: 'Lines' });
  const row = legend.getByRole('button', { name: new RegExp(`^${RUN_CHART_OUTLIER_JOB}`) });
  await expect(row).toContainText('150 s');
  const before = await readRunChart(host);
  await legend.getByRole('button', { name: /^lint/ }).click();
  await expect.poll(async () => (await readRunChart(host)).lines.length).toBe(RUN_CHART_JOBS.length - 1);
  const colors = new Map(before.lines.map((l) => [l.name, l.color]));
  for (const l of (await readRunChart(host)).lines) expect(l.color).toEqual(colors.get(l.name));

  const dot = await runDot(host, RUN_CHART_OUTLIER_JOB, 1);
  await page.mouse.move(dot.x, dot.y);
  await expect(row).toContainText('122 s');
});

test('labels are in local time', async ({ page, reportUrl }) => {
  const host = await open(page, reportUrl);
  // The oldest run: its label is the first, which `hideOverlap` always keeps.
  const timeZone = 'Asia/Tokyo';
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone });
  const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', timeZone });
  const texts = (await drawnTexts(host)).map((t) => t.text);
  expect(texts).toContain(date.format(RUN_CHART_T0_MS));
  expect(texts).toContain(time.format(RUN_CHART_T0_MS));
});

test('Copy config writes the current toggles', async ({ page, reportUrl }) => {
  await stubClipboard(page);
  await open(page, reportUrl);
  await toggle(page, 'Legend').click();
  await toggle(page, 'Slider').click();
  await page.getByRole('button', { name: 'Copy config' }).click();
  await expect.poll(() => copied(page)).toContain('runBy');
  const yaml = parse(await copied(page)) as {
    dashboards?: { widgets: { controls?: unknown }[] }[];
    widgets?: { controls?: unknown }[];
  };
  const widgets = yaml.dashboards?.[0]?.widgets ?? yaml.widgets;
  expect(widgets?.[0]?.controls).toEqual({ slider: false, evenSpacing: true, split: true, legend: true });
});

test('switching the theme keeps the zoom, the hidden line and the toggles', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  const host = await open(page, reportUrl);
  await toggle(page, 'Legend').click();
  await card(page).getByRole('list', { name: 'Lines' }).getByRole('button', { name: /^lint/ }).click();
  await expect.poll(async () => (await readRunChart(host)).lines.length).toBe(RUN_CHART_JOBS.length - 1);
  await zoomPastOldest(page, host);
  const before = await readRunChart(host);
  expect(runsInZoom(before).length).toBeLessThan(RUNS);
  const theme = page.locator('html');
  const was = await theme.getAttribute('data-theme');
  await page.getByRole('button', { name: was === 'dark' ? 'Light theme' : 'Dark theme' }).click();
  await expect(theme).toHaveAttribute('data-theme', was === 'dark' ? 'light' : 'dark');
  await expect.poll(async () => runsInZoom(await readRunChart(host))).toEqual(runsInZoom(before));
  const after = await readRunChart(host);
  expect(after.lines.map((l) => l.name)).toEqual(before.lines.map((l) => l.name));
  expect(after.yMax).toEqual(before.yMax);
  await expect(toggle(page, 'Legend')).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(page, 'Reset')).toBeEnabled();
  expect(problems).toEqual([]);
});

test('a job named in markup shows as text in the tooltip and the legend', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  const host = await open(page, reportUrl, 'runs-hostile');
  const legend = card(page).getByRole('list', { name: 'Lines' });
  await expect(legend).toContainText(RUN_CHART_HOSTILE_JOB);
  await expect(legend.locator('img')).toHaveCount(0);
  const dot = await runDot(host, RUN_CHART_HOSTILE_JOB, 2);
  await page.mouse.move(dot.x, dot.y);
  const tooltip = tooltipOf(host);
  await expect(tooltip).toContainText(RUN_CHART_HOSTILE_JOB);
  await expect(tooltip.locator('img')).toHaveCount(0);
  expect(problems).toEqual([]);
});
