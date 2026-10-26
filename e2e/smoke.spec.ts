import { RUN_TITLE } from './fixture.js';
import { expect, test } from './test.js';

test('the report loads cleanly as classic scripts and shows the run title', async ({ page, baseURL }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });

  await page.goto(`${baseURL ?? ''}/index.html`);
  await expect(page.getByRole('heading', { name: RUN_TITLE })).toBeVisible();
  expect(await page.title()).toBe(RUN_TITLE);
  expect(await page.evaluate(() => document.querySelectorAll('script[type=module]').length)).toBe(0);
  expect(problems).toEqual([]);
});

test('a report whose data/manifest.js is missing shows a load failure naming it', async ({
  page,
  baseURL,
}) => {
  await page.route('**/data/manifest.js', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto(`${baseURL ?? ''}/index.html`);
  await expect(page.getByRole('heading', { name: 'This report could not be loaded' })).toBeVisible();
  await expect(page.getByText('data/manifest.js').first()).toBeVisible();
});
