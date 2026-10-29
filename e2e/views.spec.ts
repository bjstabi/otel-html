import type { Page } from '@playwright/test';
import { copied, stubClipboard } from './clipboard.js';
import { watchProblems } from './metric-chart.js';
import { expect, test } from './test.js';

const views = (page: Page) => page.getByRole('button', { name: 'Views' });

test('Views applies a config view on each explorer, keeping the time range', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  const base = `${reportUrl('dashboards')}/index.html`;

  await page.goto(`${base}#/traces?t=1000~2000000000000`);
  await expect(page.getByRole('grid', { name: 'Results' })).toBeVisible();
  await views(page).click();
  await expect(page.getByText('From config')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Spans by service' }).click();
  await expect(page).toHaveURL(/[?&]view=toplist/);
  await expect(page).toHaveURL(/[?&]t=1000~2000000000000/);

  await page.goto(`${base}#/logs`);
  await expect(page.getByRole('grid', { name: 'Results' }).getByRole('row').nth(1)).toBeVisible();
  await views(page).click();
  await page.getByRole('menuitem', { name: 'Warnings and errors' }).click();
  await expect(page).toHaveURL(/[?&]q=/);
  await expect(page.getByRole('main')).toContainText('19 logs');

  await page.goto(`${base}#/metrics`);
  await views(page).click();
  await page.getByRole('menuitem', { name: 'Request latency p95' }).click();
  await expect(page).toHaveURL(/[?&]m=/);
  await expect(page.getByRole('img', { name: /: [1-9]\d* series$/ }).first()).toBeVisible();
  expect(problems).toEqual([]);
});

test('Views saves the current view in this browser and deletes it again', async ({ page, reportUrl }) => {
  const problems = watchProblems(page);
  await page.goto(
    `${reportUrl('dashboards')}/index.html#/logs?q=${encodeURIComponent('severity_number >= 17')}`,
  );
  await expect(page.getByRole('grid', { name: 'Results' })).toBeVisible();
  await views(page).click();
  await page.getByRole('menuitem', { name: 'Save current view…' }).click();
  await page.getByRole('textbox', { name: 'View title' }).fill('Errors only');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // Applying it from another state restores the query.
  await page.goto(`${reportUrl('dashboards')}/index.html#/logs`);
  await expect(page).not.toHaveURL(/[?&]q=/);
  await views(page).click();
  await page.getByRole('menuitem', { name: 'Errors only', exact: true }).click();
  await expect(page).toHaveURL(/[?&]q=/);

  // It survives a reload, and deleting removes it.
  await page.reload();
  await views(page).click();
  await expect(page.getByRole('menuitem', { name: 'Errors only', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delete view Errors only' }).click();
  await views(page).click();
  await expect(page.getByRole('menuitem', { name: 'Errors only', exact: true })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('Copy as dashboard widget is in the Metrics Export menu and copies a widget', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await stubClipboard(page);
  await page.goto(`${reportUrl('dashboards')}/index.html#/metrics`);
  await views(page).click();
  await page.getByRole('menuitem', { name: 'Request latency p95' }).click();
  await expect(page.getByRole('img', { name: /: [1-9]\d* series$/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Export' }).click();
  const item = page.getByRole('menuitem', { name: 'Copy as dashboard widget' });
  await expect(item).toBeVisible();
  await item.click();
  await expect.poll(() => copied(page)).toContain('type: metric');
  expect(problems).toEqual([]);
});
