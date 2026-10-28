import type { Locator } from '@playwright/test';
import { LINKED_SPAN, LINKED_TRACE } from './fixture.js';
import { LINE_MIN_PX, lineRunPx, watchProblems } from './metric-chart.js';
import { expect, test } from './test.js';

/** The grid's first (expanded) group draws its chart cards, each with one or more series, once scrolled into view. */
async function expectCharts(grid: Locator): Promise<void> {
  await expect(grid.getByRole('button', { expanded: true }).first()).toBeVisible();
  // Cards render lazily as they scroll into view.
  await grid.getByRole('region').first().getByRole('region').first().scrollIntoViewIfNeeded();
  const charts = grid.getByRole('img', { name: /: [1-9]\d* series$/ });
  await expect(charts.first()).toBeVisible();
  expect(await charts.count()).toBeGreaterThan(0);
  // A line, not just a legend: the points sit in consecutive buckets.
  await expect.poll(() => lineRunPx(charts.first())).toBeGreaterThan(LINE_MIN_PX);
  await expect(grid.getByRole('alert')).toHaveCount(0);
}

test('log panel Metrics tab: charts of the log’s resource around the log, with its marker', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  const q = encodeURIComponent(`span_id.string == "${LINKED_SPAN}"`);
  await page.goto(`${reportUrl('linked')}/index.html#/logs?q=${q}`);
  const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
  await rows.nth(1).click();
  const panel = page.getByTestId('log-panel');
  await panel.getByRole('tablist', { name: 'Log views' }).getByRole('tab', { name: 'Metrics' }).click();
  await expect(page).toHaveURL(/[?&]ltab=metrics/);
  const grid = panel.getByTestId('metric-grid');
  await expect(grid).toContainText('Metrics from the same resource');
  await expect(grid).toContainText('service.name=payments');
  // The marker line on each chart is the log's time; the header names it.
  await expect(grid).toContainText('┆ this log');
  await expectCharts(grid);

  // Size L redraws the charts taller.
  const first = grid.getByRole('img', { name: /: [1-9]\d* series$/ }).first();
  const small = (await first.boundingBox())?.height ?? 0;
  await grid.getByRole('button', { name: 'L', exact: true }).click();
  await expect(grid.getByRole('button', { name: 'L', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await first.boundingBox())?.height ?? 0).toBeGreaterThan(small);
  expect(problems).toEqual([]);
});

test('the span section and the trace panel have Metrics tabs too', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  const base = `${reportUrl('linked')}/index.html`;
  await page.goto(`${base}#/traces?trace=${LINKED_TRACE}&span=${LINKED_SPAN}`);
  const section = page.getByRole('region', { name: 'Span details' });
  await section.getByRole('tablist', { name: 'Span views' }).getByRole('tab', { name: 'Metrics' }).click();
  const spanGrid = section.getByTestId('metric-grid');
  await expect(spanGrid).toContainText('┆ this span');
  await expect(spanGrid).toContainText('service.name=payments');
  await expectCharts(spanGrid);

  const panel = page.getByTestId('trace-panel');
  await panel.getByRole('tablist', { name: 'Trace views' }).getByRole('tab', { name: 'Metrics' }).click();
  await expect(page).toHaveURL(/[?&]tab=metrics/);
  const traceGrid = panel.getByTestId('metric-grid').first();
  await expect(traceGrid).toContainText('Metrics from the same resources');
  await expect(traceGrid).toContainText('┆ trace start');
  await expectCharts(traceGrid);

  // Open in Explorer carries the grid's metrics and window.
  await traceGrid.getByRole('button', { name: 'Open in Explorer →' }).click();
  await expect(page).toHaveURL(/#\/metrics\?/);
  await expect(page).toHaveURL(/[?&]t=\d+~\d+/);
  await expect(page.getByRole('img', { name: /: [1-9]\d* series$/ }).first()).toBeVisible();
  expect(problems).toEqual([]);
});
