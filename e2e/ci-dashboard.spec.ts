import type { Locator, Page } from '@playwright/test';
import { watchProblems } from './metric-chart.js';
import { expect, HTTP, test } from './test.js';

/** The widget ids the CI config's 15 widgets get by position: six stats, then the nine views. */
const VIEW_IDS = {
  trend: 'w7',
  runs: 'w8',
  jobs: 'w9',
  grid: 'w10',
  failures: 'w11',
  triggers: 'w12',
  queue: 'w13',
  minutes: 'w14',
  tests: 'w15',
} as const;

const widget = (page: Page, id: string): Locator => page.locator(`[data-widget="${id}"]`);

async function openCi(page: Page, url: string): Promise<void> {
  await page.goto(`${url}/index.html#/dashboards/ci`);
  await expect(page.getByRole('heading', { level: 1, name: 'CI' })).toBeVisible();
  await expect(
    widget(page, VIEW_IDS.grid).getByRole('group', { name: 'Job results over the last runs' }),
  ).toBeVisible();
}

test('every view renders without console errors', HTTP, async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  await openCi(page, reportUrl('ci'));
  await expect(page.locator('[data-widget]')).toHaveCount(15);
  for (let i = 1; i <= 15; i++) {
    const w = widget(page, `w${i}`);
    await expect(w, `w${i} has content`).not.toBeEmpty();
    await expect(w.getByRole('alert'), `w${i} has no error`).toHaveCount(0);
  }
  expect(problems).toEqual([]);
});

/** The horizontal centre of an element, in page pixels. */
async function centreX(l: Locator): Promise<number> {
  const b = await l.boundingBox();
  if (b === null) throw new Error('the element is laid out');
  return b.x + b.width / 2;
}

test('main and pull requests exclude each other and release', HTTP, async ({ page, reportUrl }) => {
  await openCi(page, reportUrl('ci'));
  const bar = page.getByTestId('filter-bar');
  const main = bar.getByRole('button', { name: 'main', exact: true });
  const prs = bar.getByRole('button', { name: 'pull requests', exact: true });
  await prs.click();
  await expect(prs).toHaveAttribute('aria-pressed', 'true');
  await main.click();
  await expect(main).toHaveAttribute('aria-pressed', 'true');
  await expect(prs).toHaveAttribute('aria-pressed', 'false');
  await expect(bar.getByRole('combobox', { name: 'trigger' })).toContainText('+ trigger');
  await expect(bar.getByRole('combobox', { name: 'branch' })).toContainText('branch = main');
  await main.click();
  await expect(main).toHaveAttribute('aria-pressed', 'false');
  await expect(bar.getByRole('combobox', { name: 'branch' })).toContainText('+ branch');
});

test('a status-grid cell opens the run under the grid, its caret over the cell; side panel opens Jobs', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 1360, height: 900 });
  await openCi(page, reportUrl('ci'));
  const grid = widget(page, VIEW_IDS.grid);
  const cell = grid.locator('[data-cell]').nth(3);
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
  const pane = page.getByTestId('run-pane');
  await expect(pane).toBeVisible();
  await expect(pane.getByTestId('run-gantt')).toBeVisible();
  const g = await grid.boundingBox();
  const p = await pane.boundingBox();
  if (g === null || p === null) throw new Error('both are laid out');
  expect(p.y, 'the pane is under the grid row').toBeGreaterThanOrEqual(g.y + g.height - 2);
  expect(Math.abs((await centreX(page.getByTestId('run-caret'))) - (await centreX(cell)))).toBeLessThan(6);
  await expect(grid.getByTestId('run-connector')).toBeAttached();

  await pane.getByRole('button', { name: /side panel/ }).click();
  await expect(page.getByTestId('run-pane')).toHaveCount(0);
  // the panel narrows the page, so all 15 widgets lay out again while it reads the trace: ~0.2 s idle, 2.7-3.8 s with
  // four WebKit workers on one core, and past the 5 s default on a CI runner
  await expect(page.getByRole('tab', { name: 'Jobs' })).toHaveAttribute('aria-selected', 'true', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('run-gantt')).toBeVisible();
  expect(problems).toEqual([]);
});

test('the status grid is reachable by keyboard: Tab lands on a run dot, the arrows move, Space opens', async ({
  page,
  reportUrl,
}) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await openCi(page, reportUrl('ci'));
  const grid = widget(page, VIEW_IDS.grid);
  const first = grid.locator('[data-run-dot][tabindex="0"]');
  await expect(first).toHaveCount(1);
  await expect(grid.locator('[data-cell][tabindex]')).toHaveCount(0);
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(grid.locator('[data-run-dot][tabindex="0"]')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('run-pane')).toBeVisible();
});

test('the follow toggle of a narrow stat tile stays inside its header', async ({ page, reportUrl }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await openCi(page, reportUrl('ci'));
  const tile = page
    .locator('[data-widget]')
    .filter({ has: page.getByRole('button', { name: /follows selection/ }) })
    .first();
  const header = await tile.locator('header').boundingBox();
  const toggle = await tile.getByRole('button', { name: /follows selection/ }).boundingBox();
  if (header === null || toggle === null) throw new Error('both are laid out');
  expect(toggle.x + toggle.width).toBeLessThanOrEqual(header.x + header.width + 1);
});

test('Filter the page by job sets the chip; the runs view ignores it, the jobs view echoes it', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 1360, height: 900 });
  await openCi(page, reportUrl('ci'));
  const row = widget(page, VIEW_IDS.grid).locator('[data-job-row]').first();
  const job = (await row.getAttribute('data-job-row')) ?? '';
  await row.scrollIntoViewIfNeeded();
  // the scroll event of that scroll is delivered a frame later, and a scroll closes an open menu
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await row.locator('rect[data-label-hit]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Filter the page by job' }).click();
  await expect(page.getByRole('button', { name: 'Clear job' })).toBeVisible();
  await expect(widget(page, VIEW_IDS.runs).getByTestId('echo')).toContainText('ignores job');
  await expect(widget(page, VIEW_IDS.jobs).getByTestId('echo')).toContainText(`job = ${job}`);
  expect(problems).toEqual([]);
});

test('dragging the slider redraws runs-trend: its bucket subtitle changes', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 1360, height: 900 });
  await openCi(page, reportUrl('ci'));
  const trend = widget(page, VIEW_IDS.trend);
  await expect(trend).toContainText(/ buckets/);
  const before = (await trend.textContent())?.match(/[\d.]+ \w+ buckets/)?.[0];
  const end = page.getByRole('slider', { name: 'Zoom end' });
  const b = await end.boundingBox();
  const track = await page.getByTestId('range-slider').boundingBox();
  if (b === null || track === null) throw new Error('the slider is laid out');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * 0.3, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('zoom-selection')).toContainText('runs');
  await expect(trend).not.toContainText(before ?? '', { useInnerText: true });
  expect(problems).toEqual([]);
});

test('on a phone nothing scrolls sideways, stats pair, the run pane follows its widget, no echo chips', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openCi(page, reportUrl('ci'));
  const noSideScroll = async (): Promise<void> => {
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll, 'the page does not scroll sideways').toBeLessThanOrEqual(client);
  };
  await noSideScroll();

  // the six stat tiles (w 2) sit two to a row
  const tiles = await Promise.all(
    ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map(async (id) => {
      const b = await widget(page, id).boundingBox();
      if (b === null) throw new Error(`${id} is laid out`);
      return b;
    }),
  );
  for (const [a, b] of [
    [0, 1],
    [2, 3],
    [4, 5],
  ] as const) {
    const left = tiles[a];
    const right = tiles[b];
    if (left === undefined || right === undefined) throw new Error('six tiles');
    expect(Math.abs(left.y - right.y), `tiles ${a + 1} and ${b + 1} share a row`).toBeLessThan(2);
    expect(right.x).toBeGreaterThan(left.x + left.width - 2);
    expect(left.width).toBeLessThan(250);
  }

  // a filter is in the bar, and no widget echoes it
  await page.getByRole('button', { name: 'main', exact: true }).click();
  await expect(page.getByTestId('echo')).toHaveCount(0);

  // a clicked run's pane comes right after its widget
  const grid = widget(page, VIEW_IDS.grid);
  const dot = grid.locator('[data-run-dot]').first();
  await dot.scrollIntoViewIfNeeded();
  await dot.click();
  const pane = page.getByTestId('run-pane');
  await expect(pane).toBeVisible();
  const g = await grid.boundingBox();
  const p = await pane.boundingBox();
  const next = await widget(page, VIEW_IDS.failures).boundingBox();
  if (g === null || p === null || next === null) throw new Error('all are laid out');
  expect(p.y, 'the pane is under the grid').toBeGreaterThanOrEqual(g.y + g.height - 2);
  expect(p.y + p.height, 'and above the next widget').toBeLessThanOrEqual(next.y + 2);
  expect(p.width).toBeLessThanOrEqual(390);
  await noSideScroll();
  expect(problems).toEqual([]);
});

test("Open on GitHub goes to the run's page", HTTP, async ({ page, reportUrl }) => {
  // The page guard fails any request off this machine, so the tab is not really opened: window.open is recorded.
  await page.addInitScript(() => {
    const calls: unknown[][] = [];
    (window as unknown as { opened: unknown[][] }).opened = calls;
    window.open = (...args: unknown[]) => {
      calls.push(args);
      return null;
    };
  });
  await page.setViewportSize({ width: 1360, height: 900 });
  await openCi(page, reportUrl('ci'));
  const cell = widget(page, VIEW_IDS.grid).locator('[data-cell]').nth(3);
  await cell.scrollIntoViewIfNeeded();
  await cell.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Open on GitHub/ }).click();
  // the repository may still be loading at the click: the blank tab (recorded as ['', '_blank']) comes first then
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { opened: unknown[][] }).opened.at(-1)))
    .toEqual([
      expect.stringMatching(/^https:\/\/github\.com\/example\/otel-html\/actions\/runs\/\d+$/),
      '_blank',
      'noopener',
    ]);
});
