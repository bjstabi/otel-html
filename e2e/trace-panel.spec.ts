import {
  HOSTILE_SPAN_NAME,
  LARGE_REPORT_DIR,
  LARGE_SPAN_COUNT,
  LARGE_TRACE_ID,
  perfFactor,
  SERVICE_A,
  SERVICE_B,
  TRACE_1,
  TRACE_2,
} from './fixture.js';
import { expect, test } from './test.js';

/** Fixed budget; `OTEL_HTML_PERF_FACTOR` scales it for slow machines, the constant is never loosened. */
const PERF_BUDGET_MS = 500;

interface PerfProbe {
  flameRenderMs: number;
  flameBars: number;
  layoutMs: number;
  optionMs: number;
  renderedMs: number;
}
declare global {
  interface Window {
    __OH_PERF__?: PerfProbe;
  }
}

test('trace panel: open from a row, j moves to the next trace, Esc closes and restores focus', async ({
  page,
  baseURL,
}) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('dialog', (d) => {
    problems.push(`unexpected dialog: ${d.message()}`);
    void d.dismiss();
  });

  await page.goto(`${baseURL ?? ''}/index.html#/traces?mode=traces`);
  const grid = page.getByRole('grid', { name: 'Results' });
  const rows = grid.getByRole('row');
  await expect(rows).toHaveCount(3); // header + 2 traces

  // Newest first: trace 2 (the hostile root), then trace 1.
  const first = rows.nth(1);
  const resource = (await first.getByRole('gridcell').nth(3).textContent()) ?? '';
  await first.click();
  const panel = page.getByTestId('trace-panel');
  const header = panel.getByTestId('trace-header');
  await expect(header).toContainText(TRACE_2);
  await expect(header).toContainText(SERVICE_A);
  await expect(header).toContainText(resource);
  await expect(page).toHaveURL(new RegExp(`trace=${TRACE_2}`));
  // The panel leaves a narrow column of the list visible.
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(box !== null && viewport !== null && box.x > 200).toBe(true);

  // The tabs: flame graph first, Metrics because the trace's resources report the `requests` metric, Errors present
  // because spans errored.
  await expect(panel.getByRole('tab')).toHaveText([
    'Flame graph',
    'Waterfall',
    'Span list',
    'Services',
    'Metrics',
    'Errors',
  ]);
  await expect(panel.getByRole('img', { name: /^Flame graph of 3 spans/ })).toBeVisible();

  await page.keyboard.press('j');
  await expect(header).toContainText(TRACE_1);
  await expect(page).toHaveURL(new RegExp(`trace=${TRACE_1}`));
  await page.keyboard.press('k');
  await expect(header).toContainText(TRACE_2);

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/trace=/);
  await expect(grid.locator('[role="row"]:focus')).toHaveCount(1);

  expect(problems).toEqual([]);
});

test('trace panel: waterfall, hostile names as text, errors, services, split and full page', async ({
  page,
  baseURL,
}) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('dialog', (d) => {
    problems.push(`unexpected dialog: ${d.message()}`);
    void d.dismiss();
  });

  await page.goto(`${baseURL ?? ''}/index.html#/traces?trace=${TRACE_2}&tab=waterfall`);
  const panel = page.getByTestId('trace-panel');
  const tree = panel.getByRole('tree', { name: 'Waterfall' });
  await expect(tree.getByRole('treeitem')).toHaveCount(3);
  await expect(tree).toContainText(HOSTILE_SPAN_NAME);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  // The failing child shows an icon plus a label, not only colour.
  await expect(tree.getByRole('treeitem').nth(1)).toContainText('error');

  // Selecting a span goes through the store (URL).
  await tree.getByRole('treeitem').nth(1).click();
  await expect(page).toHaveURL(/span=0502030405060708/);
  await expect(panel.getByTestId('span-header')).toContainText('db.timeout');

  await panel.getByRole('tab', { name: 'Services' }).click();
  const services = panel.getByRole('table', { name: 'Services in this trace' });
  await expect(services).toContainText(SERVICE_A);
  await expect(services).toContainText(SERVICE_B);

  await panel.getByRole('tab', { name: 'Errors' }).click();
  await expect(panel.getByRole('table', { name: 'Errors in this trace' })).toContainText('boom');

  // The split is keyboard operable and remembered.
  const sep = panel.getByRole('separator');
  await sep.focus();
  const before = Number(await sep.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowDown');
  await expect(sep).toHaveAttribute('aria-valuenow', String(before + 5));
  await page.reload();
  await expect(panel.getByRole('separator')).toHaveAttribute('aria-valuenow', String(before + 5));

  // Full page route.
  await panel.getByRole('link', { name: 'Full page' }).click();
  await expect(page).toHaveURL(new RegExp(`#/traces/trace/${TRACE_2}`));
  const full = page.getByTestId('trace-panel');
  await expect(full).toHaveAttribute('data-layout', 'page');
  await expect(full.getByTestId('trace-header')).toContainText(TRACE_2);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/#\/traces(\?|$)/);
  await expect(page.getByTestId('trace-panel')).toHaveCount(0);

  expect(problems).toEqual([]);
});

test('trace panel: flame graph click selects a span', async ({ page, baseURL }) => {
  await page.goto(`${baseURL ?? ''}/index.html#/traces?trace=${TRACE_1}`);
  const flame = page.getByRole('img', { name: /^Flame graph of 3 spans/ });
  await expect(flame).toBeVisible();
  const box = await flame.boundingBox();
  if (box === null) throw new Error('the flame graph has no box');
  // The root bar spans the full width on the first row.
  await flame.click({ position: { x: box.width / 2, y: 14 } });
  await expect(page).toHaveURL(/span=0102030405060708/);
});

test(
  'flame graph of a very large trace renders within the budget',
  { tag: '@perf' },
  async ({ page }, testInfo) => {
    test.skip(
      !testInfo.project.name.endsWith('-file'),
      'the large report is only generated for file:// loading',
    );
    // Init scripts run before the document element exists; set the marker as soon as it does.
    await page.addInitScript(() => {
      const mark = (): void => document.documentElement?.setAttribute('data-perf', '');
      mark();
      new MutationObserver(mark).observe(document, { childList: true });
    });
    await page.goto(`${LARGE_REPORT_DIR.href}index.html#/traces?trace=${LARGE_TRACE_ID}`);
    await page.waitForFunction(() => window.__OH_PERF__ !== undefined, undefined, { timeout: 60_000 });
    const perf = await page.evaluate(() => window.__OH_PERF__);
    testInfo.annotations.push({
      type: 'perf',
      description: `flame graph of ${perf?.flameBars} spans rendered in ${perf?.flameRenderMs.toFixed(0)} ms`,
    });
    process.stdout.write(
      `PERF flame ${perf?.flameBars} spans: ${perf?.flameRenderMs.toFixed(1)} ms (layout ${perf?.layoutMs.toFixed(1)}, option ${perf?.optionMs.toFixed(1)}, first paint ${perf?.renderedMs.toFixed(1)})\n`,
    );
    expect(perf?.flameBars).toBe(LARGE_SPAN_COUNT);
    expect(perf?.flameRenderMs ?? Number.POSITIVE_INFINITY).toBeLessThan(PERF_BUDGET_MS * perfFactor());
  },
);
