import { METRIC_HIST, METRICS_COUNT } from './fixture.js';
import { watchProblems } from './metric-chart.js';
import { expect, test } from './test.js';

test('the Catalog lists every metric, filters by text, and a row click opens it in the Explorer', async ({
  page,
  reportUrl,
}) => {
  const problems = watchProblems(page);
  await page.goto(`${reportUrl('linked')}/index.html#/metrics`);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Catalog' }).click();
  await expect(page).toHaveURL(/#\/metrics\/catalog/);
  const main = page.getByRole('main');
  await expect(main).toContainText(new RegExp(`\\b${METRICS_COUNT} metrics ·`));
  const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
  // The header row plus one row per metric definition.
  await expect(rows).toHaveCount(METRICS_COUNT + 1);

  await page.getByRole('searchbox', { name: 'Filter metrics' }).fill('http.server');
  await expect(rows).toHaveCount(3);
  const hist = rows.filter({ hasText: METRIC_HIST });
  await expect(hist).toHaveCount(1);
  await expect(hist).toContainText('HIST');

  await hist.click();
  await expect(page).toHaveURL(/#\/metrics\?/);
  await expect(page.getByRole('button', { name: 'Metric of a' })).toContainText(METRIC_HIST);
  // The kind's default show: a histogram's p95.
  await expect(page.getByRole('combobox', { name: 'Show of a' })).toHaveValue('p95');
  await expect(
    page.getByRole('img', { name: new RegExp(`^${METRIC_HIST} · p95: [1-9]\\d* series$`) }),
  ).toBeVisible();
  expect(problems).toEqual([]);
});
