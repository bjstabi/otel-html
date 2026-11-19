import type { Locator, Page } from '@playwright/test';
import { parse } from 'yaml';
import { copied, stubClipboard } from './clipboard.js';
import { DASHBOARDS_ENV_DEFAULT } from './fixture.js';
import { watchProblems } from './metric-chart.js';
import { expect, HTTP, test } from './test.js';

const widget = (page: Page, id: string): Locator => page.locator(`[data-widget="${id}"]`);

/** The `N logs` (or `N traces`) count in a widget's subtitle, once it shows one. */
async function countIn(w: Locator, noun: string): Promise<number> {
  const re = new RegExp(`(?:^|\\D)(\\d+) ${noun}s?`);
  await expect(w).toContainText(re);
  const m = re.exec((await w.textContent()) ?? '');
  if (m?.[1] === undefined) throw new Error(`no ${noun} count`);
  return Number(m[1]);
}

/** Drags across a widget's timeline brush, from `from` to `to` as fractions of its width. */
async function brush(page: Page, timeline: Locator, from: number, to: number): Promise<void> {
  const box = await timeline.getByRole('group', { name: 'Time brush' }).boundingBox();
  if (box === null) throw new Error('the brush is laid out');
  await page.mouse.move(box.x + box.width * from, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
}

test(
  'the list shows Fusion (built-in), Checkout (its file, starred) and CI',
  HTTP,
  async ({ page, reportUrl }) => {
    const problems = watchProblems(page);
    await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards`);
    const rows = page.getByRole('table').getByRole('row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(1)).toContainText('Fusion');
    await expect(rows.nth(1)).toContainText('BUILT-IN');
    await expect(rows.nth(2)).toContainText('Checkout');
    await expect(rows.nth(2)).toContainText('dashboards.otel-html.yaml');
    await expect(rows.nth(2).getByRole('img', { name: 'Default dashboard' })).toBeVisible();
    await expect(rows.nth(3)).toContainText('CI');
    await expect(rows.nth(1).getByRole('img', { name: 'Default dashboard' })).toHaveCount(0);

    // `g d` and the home route (`viewer.home: dashboards`) both open the configured default.
    await page.goto(`${reportUrl('dashboards')}/index.html#/`);
    await expect(page).toHaveURL(/#\/dashboards\/checkout/);
    await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/fusion`);
    await expect(page.getByRole('heading', { level: 1, name: 'Fusion' })).toBeVisible();
    await page.keyboard.press('g');
    await page.keyboard.press('d');
    await expect(page).toHaveURL(/#\/dashboards\/checkout/);
    await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
    expect(problems).toEqual([]);
  },
);

test('Fusion: a brush, a trace click, ⛓ off and Show context', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/fusion`);
  const timeline = widget(page, 'timeline');
  const traces = widget(page, 'traces');
  const logs = widget(page, 'logs');
  const metrics = widget(page, 'metrics');
  await expect(traces.getByRole('grid', { name: 'Results' }).getByRole('row').nth(1)).toBeVisible();
  await expect(traces).toContainText(/\d+ traces?/);
  await expect(metrics).toContainText('all resources');

  // Brushing the timeline adds a time chip; the Traces widget follows it.
  await brush(page, timeline, 0.05, 0.95);
  const chips = page.getByRole('list', { name: 'Selection' });
  await expect(chips).toContainText('time');
  await expect(traces).toContainText('in selected time');
  await expect(page).toHaveURL(/[?&]d=/);

  // A trace click adds the trace chip; Logs narrows to it and Metrics to its resources.
  await traces.getByRole('grid', { name: 'Results' }).getByRole('row').nth(1).click();
  await expect(chips).toContainText('trace_id');
  await expect(logs).toContainText('for the selected trace');
  await expect(metrics).toContainText("from the selected trace's resources");
  await expect(metrics.getByTestId('metric-grid')).toContainText('Metrics from the same resource');
  await expect(metrics.getByTestId('metric-grid')).not.toContainText('Loading metrics');

  // The trace's flame graph opens under the list.
  await expect(traces.getByRole('button', { name: 'open trace panel →' })).toBeVisible();

  // ⛓ off on Logs lists all logs of the window again.
  const follows = logs.getByRole('button', { name: 'follows selection' });
  await expect(follows).toHaveAttribute('aria-pressed', 'true');
  await follows.click();
  await expect(follows).toHaveAttribute('aria-pressed', 'false');
  await expect(logs).not.toContainText('for the selected trace');
  await expect(logs).toContainText(/\d+ logs?/);

  // Show context lists every log of the window and marks the matches.
  await follows.click();
  await expect(logs).toContainText('for the selected trace');
  await logs.getByRole('button', { name: 'Show context' }).click();
  await expect(logs.getByRole('button', { name: 'Show context' })).toHaveAttribute('aria-pressed', 'true');
  const rows = logs.getByRole('grid', { name: 'Results' }).getByRole('row');
  await expect(rows.nth(1)).toBeVisible();
  await expect(logs.locator('[data-match="true"]').first()).toBeVisible();
  await expect(logs.locator('[data-muted="true"]').first()).toBeVisible();

  // Clear all removes the selection.
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(chips).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('Fusion: a variable value narrows the Logs widget and the URL carries it', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/fusion`);
  const logs = widget(page, 'logs');
  const all = await countIn(logs, 'log');
  const service = page.getByRole('combobox', { name: 'service.name' });
  await service.click();
  await page.getByRole('option', { name: 'checkout', exact: true }).click();
  await expect(service).toContainText('checkout');
  await expect(page).toHaveURL(/service\.name/);
  await expect.poll(() => countIn(logs, 'log')).toBeLessThan(all);
  await expect(widget(page, 'traces')).toContainText(/\d+ traces?/);
  expect(problems).toEqual([]);
});

test('Checkout: the environment default narrows everything until it is changed', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/checkout`);
  const env = page.getByRole('combobox', { name: 'environment' });
  await expect(env).toContainText(DASHBOARDS_ENV_DEFAULT);
  // The default names no environment of this report, so the list is empty.
  const traces = widget(page, 'w2');
  await expect(traces).toContainText('No traces match');
  await expect(traces).toContainText(/(?:^|\D)0 traces/);
  await env.click();
  await page.getByRole('option', { name: 'production' }).click();
  // The choice sticks: an option that vanished on selection once reset the variable to "all".
  await expect(env).toContainText('production');
  await expect(page).toHaveURL(/production/);
  await expect(traces).toContainText('3 traces');
  await expect(traces).not.toContainText('No traces match');
  await expect(traces.getByRole('grid', { name: 'Results' }).getByRole('row').nth(1)).toBeVisible();
  // It stays chosen once the lists have settled.
  await expect(env).toContainText('production');
  // All six widget types are on the page.
  for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']) await expect(widget(page, id)).toBeVisible();
  await expect(widget(page, 'w4').getByRole('heading', { name: 'Request latency' })).toBeVisible();
  await expect(widget(page, 'w4').getByRole('img', { name: /: [1-9]\d* series$/ })).toBeVisible();
  expect(problems).toEqual([]);
});

test('Edit layout: drag Logs, then Copy config holds the new position', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  await stubClipboard(page);
  await page.setViewportSize({ width: 1400, height: 1600 });
  await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/fusion`);
  const logs = widget(page, 'logs');
  await expect(logs).toBeVisible();
  await page.getByRole('button', { name: 'Edit layout' }).click();
  const handle = logs.getByRole('button', { name: 'Move Logs' });
  const box = await handle.boundingBox();
  if (box === null) throw new Error('the drag handle is laid out');
  // Below the Metrics widget, the only free place.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 700, { steps: 12 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Copy config' }).click();
  await expect.poll(() => copied(page)).toContain('id: fusion-copy');
  const yaml = await copied(page);
  expect(yaml).toContain('title: Fusion (copy)');
  const doc = parse(yaml) as {
    dashboards: { widgets: { id?: string; type: string; x: number; y: number }[] }[];
  };
  const moved = doc.dashboards[0]?.widgets.find((w) => w.type === 'logs');
  expect(moved?.id).toBe('logs');
  // Fusion has Logs at (7, 6); the drag took it below the Metrics widget (rows 19-28), in its own column.
  expect(moved?.x).toBe(7);
  expect(moved?.y).toBeGreaterThanOrEqual(29);
  const others = doc.dashboards[0]?.widgets.filter((w) => w.type !== 'logs') ?? [];
  expect(others.map((w) => [w.type, w.x, w.y]).sort()).toEqual([
    ['metric', 0, 19],
    ['timeline', 0, 0],
    ['traces', 0, 6],
  ]);
  expect(problems).toEqual([]);
});

test('Open in Logs from a widget lands on Logs with the widget condition', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/checkout`);
  await page.getByRole('combobox', { name: 'environment' }).click();
  await page.getByRole('option', { name: 'production' }).click();
  await expect(page).toHaveURL(/production/);
  const shown = await countIn(widget(page, 'w3'), 'log');
  await widget(page, 'w3')
    .getByRole('button', { name: /Open in Logs/ })
    .click();
  await expect(page).toHaveURL(/#\/logs\?/);
  await expect(page).toHaveURL(/[?&]q=/);
  // The widget's condition travels with the variable: its query and the environment, joined with `and`.
  const q = new URL(page.url().replace('#', '')).search;
  expect(decodeURIComponent(q.replace(/\+/g, ' '))).toContain('severity_number >= 13');
  expect(decodeURIComponent(q.replace(/\+/g, ' '))).toContain('deployment.environment.name');
  // The query bar shows the condition, and the page counts what the widget counted.
  const filters = page.getByRole('list', { name: 'Filters' });
  await expect(filters).toContainText('severity_number');
  await expect(filters).toContainText('deployment.environment.name');
  await expect(page.getByRole('textbox', { name: 'Value of severity_number' })).toHaveValue('13');
  await expect(page.getByRole('main')).toContainText(new RegExp(`(?:^|\\D)${shown} logs?`));
  await expect(page.getByRole('grid', { name: 'Results' }).getByRole('row').nth(1)).toBeVisible();
  expect(problems).toEqual([]);
});

test('Copy config on Checkout copies YAML of the dashboard', async ({ page, reportUrl }) => {
  await stubClipboard(page);
  await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/checkout`);
  await page.getByRole('button', { name: 'Copy config' }).click();
  await expect.poll(() => copied(page)).toContain('id: checkout');
  const yaml = await copied(page);
  expect(yaml).toContain('http.server.request.duration');
  expect(yaml).toContain('show: false');
});

test('Copy config with the real clipboard: Chromium reads it back, elsewhere it is copied or offered by hand', async ({
  page,
  context,
  browserName,
  reportUrl,
}) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/checkout`);
  await page.getByRole('button', { name: 'Copy config' }).click();
  const byHand = page.getByRole('textbox', { name: 'Dashboard config' });
  const done = page.getByRole('status').filter({ hasText: 'Copied' });
  await expect(done.or(byHand)).toBeVisible();
  if (browserName === 'chromium') {
    await expect(done).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('id: checkout');
  } else if (await byHand.isVisible()) {
    await expect(byHand).toHaveValue(/id: checkout/);
  }
});

test('below 768 px the widgets stack in reading order and the layout cannot be edited', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 700, height: 1200 });
  await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/fusion`);
  const ids = ['timeline', 'traces', 'logs', 'metrics'];
  for (const id of ids) await expect(widget(page, id)).toBeVisible();
  const tops = await Promise.all(ids.map(async (id) => (await widget(page, id).boundingBox())?.y ?? -1));
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);
  const lefts = await Promise.all(ids.map(async (id) => (await widget(page, id).boundingBox())?.x ?? -1));
  expect(new Set(lefts).size).toBe(1);
  await expect(page.getByRole('button', { name: 'Edit layout' })).toBeDisabled();
  expect(problems).toEqual([]);
});

/** The page filter bar of a dashboard. */
const filterBar = (page: Page): Locator => page.getByTestId('filter-bar');

/** The run-charts report spans about 31 h, so the shorter presets are offered there (the dashboards fixture is seconds long). */
const RUNS_DASHBOARD = (reportUrl: (name: 'run-charts') => string): string =>
  `${reportUrl('run-charts')}/index.html#/dashboards/runs`;

test('the range menu sets the page window and the label names it', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  await page.goto(RUNS_DASHBOARD(reportUrl));
  const bar = filterBar(page);
  const menu = bar.getByRole('button', { name: 'Time range' });
  await expect(menu).toContainText('entire run');
  await menu.click();
  // The longest preset a 31 h run offers; 30d and above appear only on a longer run.
  await expect(page.getByRole('menuitem', { name: '30d', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '24h', exact: true }).click();
  await expect(page).toHaveURL(/[?&]t=/);
  await expect(menu).toContainText('last 24 hours');
  expect(problems).toEqual([]);
});

test('dragging the slider zooms: the label reads last…, of…, and "↺ full range" clears it', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.goto(RUNS_DASHBOARD(reportUrl));
  const bar = filterBar(page);
  const menu = bar.getByRole('button', { name: 'Time range' });
  await expect(bar.getByRole('button', { name: '↺ full range' })).toHaveCount(0);
  const track = bar.getByTestId('range-slider');
  await expect(track).toBeVisible();
  const box = await track.boundingBox();
  if (box === null) throw new Error('the slider is laid out');
  const handle = await bar.getByRole('slider', { name: 'Zoom start' }).boundingBox();
  if (handle === null) throw new Error('the start handle is laid out');
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 8 });
  await page.mouse.up();
  await expect(menu).toContainText(/last .* of /);
  const full = bar.getByRole('button', { name: '↺ full range' });
  await expect(full).toBeVisible();
  await full.click();
  await expect(full).toHaveCount(0);
  await expect(menu).not.toContainText(' of ');
  expect(problems).toEqual([]);
});

test('at 390 px a slider handle is at least 24 px wide', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(RUNS_DASHBOARD(reportUrl));
  const handle = await filterBar(page).getByRole('slider', { name: 'Zoom start' }).boundingBox();
  if (handle === null) throw new Error('the start handle is laid out');
  expect(handle.width).toBeGreaterThanOrEqual(24);
  expect(handle.height).toBeGreaterThanOrEqual(24);
  expect(problems).toEqual([]);
});

test('Fusion: three long filter chips never push the buttons out of a widget header', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const vars = {
    'service.name': 'a-service-with-a-very-long-name',
    'deployment.environment.name': 'an-environment-with-a-very-long-name',
    'host.name': 'a-host-with-a-very-long-name',
  };
  await page.goto(
    `${reportUrl('dashboards')}/index.html#/dashboards/fusion?d=${encodeURIComponent(JSON.stringify({ vars }))}`,
  );
  const logs = widget(page, 'logs');
  await expect(logs.getByText('host.name = a-host-with-a-very-long-name')).toBeAttached();
  const frame = await logs.boundingBox();
  if (frame === null) throw new Error('the Logs widget is laid out');
  for (const name of [/follows selection/, /Open in/]) {
    const button = logs.locator('header').getByRole('button', { name });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    if (box === null) throw new Error(`${name} is laid out`);
    expect(box.x).toBeGreaterThanOrEqual(frame.x);
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
    const clipped = await button.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(false);
  }
  expect(problems).toEqual([]);
});

test('Checkout: a quick filter sets a chip and its × clears it', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/checkout`);
  const bar = filterBar(page);
  const production = bar.getByRole('button', { name: 'Production', exact: true });
  await expect(production).toHaveAttribute('aria-pressed', 'false');
  await production.click();
  const env = bar.getByRole('combobox', { name: 'environment' });
  await expect(env).toContainText('environment = production');
  await expect(production).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('button', { name: 'Clear environment' }).click();
  await expect(env).toContainText('+ environment');
  await expect(production).toHaveAttribute('aria-pressed', 'false');
  await production.click();
  await expect(production).toHaveAttribute('aria-pressed', 'true');
  await production.click();
  await expect(production).toHaveAttribute('aria-pressed', 'false');
  await expect(env).toContainText('+ environment');
  expect(problems).toEqual([]);
});

test('Checkout: the pinned filter bar stays in view while scrolling, the unpinned one scrolls away', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/checkout`);
  const bar = filterBar(page);
  const last = widget(page, 'w8');
  await expect(bar).toBeInViewport();
  await last.scrollIntoViewIfNeeded();
  await expect(bar).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  const pin = bar.getByRole('button', { name: 'Pin filters' });
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await last.scrollIntoViewIfNeeded();
  await expect(bar).not.toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  await pin.click();
  await last.scrollIntoViewIfNeeded();
  await expect(bar).toBeInViewport();
  expect(problems).toEqual([]);
});

test('at 390 px nothing scrolls sideways, the menu opens the sidebar and two small widgets share a row', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${reportUrl('dashboards')}/index.html#/dashboards/checkout`);
  const a = widget(page, 'w7');
  const b = widget(page, 'w8');
  await expect(a).toBeVisible();
  await expect(b).toBeVisible();
  const [boxA, boxB] = [await a.boundingBox(), await b.boundingBox()];
  if (boxA === null || boxB === null) throw new Error('the small widgets are laid out');
  expect(boxB.y).toBeCloseTo(boxA.y, 0);
  expect(boxB.x).toBeGreaterThan(boxA.x + boxA.width - 1);
  expect(boxB.x + boxB.width).toBeLessThanOrEqual(390);
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(sideways).toBeLessThanOrEqual(0);
  const bar = await filterBar(page).boundingBox();
  if (bar === null) throw new Error('the filter bar is laid out');
  expect(bar.x + bar.width).toBeLessThanOrEqual(390);
  const menu = page.getByRole('button', { name: 'Menu' });
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await menu.click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await expect(menu).toBeFocused();
  // Another page does not scroll sideways either.
  await page.goto(`${reportUrl('dashboards')}/index.html#/traces`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
  expect(problems).toEqual([]);
});
