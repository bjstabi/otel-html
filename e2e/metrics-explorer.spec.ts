import { readdir } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { LINKED_SPAN, LINKED_TRACE, METRIC_HIST, reportDir } from './fixture.js';
import { exemplarRings, LINE_MIN_PX, lineRunPx, menuAt, watchProblems } from './metric-chart.js';
import { expect, HTTP, test } from './test.js';

/** In the Explorer: query `a` charts the p99 of `METRIC_HIST` by `http.route`, exemplars on. */
async function p99ByRoute(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Metric of a' }).click();
  await page.getByRole('searchbox', { name: 'Search metrics' }).fill(METRIC_HIST);
  await page.getByRole('list', { name: 'Metrics' }).getByRole('button', { name: METRIC_HIST }).click();
  await expect(page.getByRole('button', { name: 'Metric of a' })).toContainText(METRIC_HIST);
  await page.getByRole('combobox', { name: 'Show of a' }).selectOption('p99');
  await page.getByRole('button', { name: 'By of a' }).click();
  await page.getByRole('checkbox', { name: 'attributes["http.route"]' }).check();
  await page.keyboard.press('Escape');
  await page.getByRole('switch', { name: 'Exemplars' }).click();
  await expect(page.getByRole('switch', { name: 'Exemplars' })).toHaveAttribute('aria-checked', 'true');
}

/**
 * The exemplar rings once drawn. Switching Exemplars on re-runs the query and the previous lines stay up meanwhile, so
 * a chart with its lines can still lack its rings for a moment (seen on WebKit).
 */
async function ringsOf(chart: Locator): Promise<{ x: number; y: number }[]> {
  await expect.poll(async () => (await exemplarRings(chart)).length).toBeGreaterThan(0);
  return exemplarRings(chart);
}

/** The chart's legend lists one entry per series, which the chart's accessible name counts. */
const p99Chart = (page: Page) => page.getByRole('img', { name: `${METRIC_HIST} · p99: 3 series` });

test(
  'g m opens the Explorer; p99 by http.route draws 3 series; an exemplar opens its trace',
  HTTP,
  async ({ page, reportUrl }) => {
    const problems = watchProblems(page);
    await page.goto(`${reportUrl('linked')}/index.html#/traces`);
    await expect(page.getByRole('grid', { name: 'Results' })).toBeVisible();
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await expect(page).toHaveURL(/#\/metrics(\?|$)/);
    await expect(page.getByRole('heading', { level: 1, name: 'Metrics', exact: true })).toBeVisible();

    await p99ByRoute(page);
    const chart = p99Chart(page);
    await expect(chart).toBeVisible();
    await expect.poll(() => lineRunPx(chart)).toBeGreaterThan(LINE_MIN_PX);
    const json = await page.evaluate(() => decodeURIComponent(location.hash));
    expect(json).toContain('"show":"p99"');
    expect(json).toContain('"by":["attributes[\\"http.route\\"]"]');

    // Two exemplars in the run: one on LINKED_TRACE, one on a trace the report lacks.
    const rings = await ringsOf(chart);
    expect(rings).toHaveLength(2);
    const menus: string[][] = [];
    for (const ring of rings) {
      menus.push(await menuAt(page, chart, ring));
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
    }
    expect(menus.map((m) => m[0]).sort()).toEqual(['Open exemplar trace', 'trace not in this report']);
    const linked = rings[menus.findIndex((m) => m[0] === 'Open exemplar trace')];
    if (linked === undefined) throw new Error('no ring opens a trace');
    await menuAt(page, chart, linked);
    await page.getByRole('menuitem', { name: 'Open exemplar trace' }).click();
    await expect(page).toHaveURL(new RegExp(`#/traces\\?.*trace=${LINKED_TRACE}`));
    await expect(page).toHaveURL(new RegExp(`span=${LINKED_SPAN}`));
    await expect(page.getByTestId('trace-panel').getByTestId('trace-header')).toContainText(LINKED_TRACE, {
      timeout: 15_000, // the trace's first load (#279)
    });

    // Back returns to the chart as it was.
    await page.goBack();
    await expect(p99Chart(page)).toBeVisible();
    expect(problems).toEqual([]);
  },
);

test('"Logs in this window" opens the Logs Explorer with t set to the clicked bucket', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.goto(`${reportUrl('linked')}/index.html#/metrics`);
  await p99ByRoute(page);
  const chart = p99Chart(page);
  await expect(chart).toBeVisible();
  const rings = await ringsOf(chart);
  const box = await chart.boundingBox();
  if (box === null) throw new Error('the chart has no box');
  const at = { x: Math.round(box.width * 0.75), y: 60 };
  for (const r of rings) expect(Math.hypot(r.x - at.x, r.y - at.y)).toBeGreaterThan(20);

  expect(await menuAt(page, chart, at)).toEqual([
    'Traces in this window',
    'Logs in this window',
    'Zoom to this window',
  ]);
  await page.getByRole('menuitem', { name: 'Logs in this window' }).click();
  await expect(page).toHaveURL(/#\/logs\?/);
  await expect(page).toHaveURL(/[?&]t=\d+~\d+/);
  await expect(page.getByRole('heading', { level: 1, name: 'Logs', exact: true })).toBeVisible();
  expect(problems).toEqual([]);
});

test('a drag over the chart zooms to the dragged span and opens no click menu', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.goto(`${reportUrl('linked')}/index.html#/metrics`);
  await p99ByRoute(page);
  const chart = p99Chart(page);
  await expect(chart).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]t=/);
  const box = await chart.boundingBox();
  if (box === null) throw new Error('the chart has no box');
  const y = box.y + 80;
  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, y, { steps: 5 });
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 5 });
  await page.mouse.up();
  await expect(page).toHaveURL(/[?&]t=\d+~\d+/);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  expect(problems).toEqual([]);
});

/** The Catalog row of `METRIC_HIST` in `report`: its text and the sparkline's points. */
async function histRow(page: Page, url: string): Promise<{ text: string; spark: string }> {
  await page.goto(`${url}/index.html#/metrics/catalog`);
  await page.getByRole('searchbox', { name: 'Filter metrics' }).fill(METRIC_HIST);
  const row = page.getByRole('grid', { name: 'Results' }).getByRole('row').filter({ hasText: METRIC_HIST });
  await expect(row).toHaveCount(1);
  const spark = await row.locator('polyline').getAttribute('points');
  return { text: (await row.textContent()) ?? '', spark: spark ?? '' };
}

test('an unfinished report (several partitions, never closed) charts METRIC_HIST exactly', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  // The writer never closed the report: its points are still several partitions (D34).
  const partitions = new URL('data/partitions/', reportDir('unfinished'));
  const withPoints = (await readdir(partitions, { recursive: true })).filter((f) =>
    f.endsWith('points.parquet'),
  );
  expect(withPoints.length).toBeGreaterThanOrEqual(2);

  // Partition 000000 ends at 50 s of the 100 s run, so a viewer that read only it would draw the second half of the
  // sparkline empty: the row equals the closed `linked` report's only if the second partition is read.
  const closed = await histRow(page, reportUrl('linked'));
  const open = await histRow(page, reportUrl('unfinished'));
  expect(open).toEqual(closed);

  await page.getByRole('grid', { name: 'Results' }).getByRole('row').filter({ hasText: METRIC_HIST }).click();
  await p99ByRoute(page);
  await expect(p99Chart(page)).toBeVisible();
  // The result is exact: no note says the report is unfinished or merged from segments.
  await expect(page.getByText('report unfinished')).toHaveCount(0);
  await expect(page.getByText('flush segments')).toHaveCount(0);
  // The exemplars both sit in the first partition (collections 0 and 8, flushed before the second).
  expect(await ringsOf(p99Chart(page))).toHaveLength(2);
  expect(problems).toEqual([]);
});
