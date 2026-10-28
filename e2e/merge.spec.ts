import { fixtureSpanCount, LINKED_LOG_COUNT, METRICS_COUNT } from './fixture.js';
import { expect, test } from './test.js';

test('otel-html merge of two fixture reports shows the union span count', async ({ page, reportUrl }) => {
  const small = fixtureSpanCount('small');
  const orphans = fixtureSpanCount('orphans');
  const count = page.getByRole('main').locator('output', { hasText: /\bspans\b/ });

  // The inputs on their own, so the union is not a coincidence of one of them.
  await page.goto(`${reportUrl('small')}/index.html#/traces`);
  await expect(count).toHaveText(new RegExp(`^${small} spans`));
  await page.goto(`${reportUrl('orphans')}/index.html#/traces`);
  await expect(count).toHaveText(new RegExp(`^${orphans} spans`));

  await page.goto(`${reportUrl('merged')}/index.html#/traces`);
  await expect(count).toHaveText(new RegExp(`^${small + orphans} spans`));
  const grid = page.getByRole('grid', { name: 'Results' });
  await expect(grid.getByRole('row').nth(1)).toBeVisible();
});

test('the sample report (demo and CI artifact) holds both traces and logs', async ({ page, reportUrl }) => {
  const main = page.getByRole('main');
  await page.goto(`${reportUrl('sample')}/index.html#/traces`);
  await expect(main.locator('output', { hasText: /\bspans\b/ })).toHaveText(
    new RegExp(`^${fixtureSpanCount('sample')} spans`),
  );
  await page.goto(`${reportUrl('sample')}/index.html#/logs`);
  await expect(main.locator('output', { hasText: /\blogs\b/ })).toHaveText(
    new RegExp(`^${LINKED_LOG_COUNT} logs`),
  );
});

test('a merged report with metrics has the same Catalog as a single conversion of its inputs', async ({
  page,
  reportUrl,
}) => {
  const catalogOf = async (report: 'metrics-merged' | 'metrics-single'): Promise<string[]> => {
    await page.goto(`${reportUrl(report)}/index.html#/metrics/catalog`);
    const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
    await expect(rows).toHaveCount(METRICS_COUNT + 1);
    const header =
      (await page
        .getByRole('main')
        .getByText(/ metrics · \d+ scopes$/)
        .textContent()) ?? '';
    const cells = await Promise.all(
      (await rows.all()).map(async (r) => (await r.getByRole('gridcell').allTextContents()).join(' | ')),
    );
    return [header, ...cells];
  };
  const single = await catalogOf('metrics-single');
  expect(single[0]).toMatch(new RegExp(`^${METRICS_COUNT} metrics · \\d+ scopes$`));
  expect(await catalogOf('metrics-merged')).toEqual(single);
});
