import { fixtureSpanCount } from './fixture.js';
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
