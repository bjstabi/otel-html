import { ERROR_SPAN_COUNT, HOSTILE_SPAN_NAME, SERVICE_B, SPAN_COUNT } from './fixture.js';
import { expect, test } from './test.js';

const ERRORS = 'status.code == STATUS_CODE_ERROR';

test('Traces explorer: OTTL filter, facets, URL state, hostile text', async ({ page, baseURL }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('dialog', (d) => {
    problems.push(`unexpected dialog: ${d.message()}`);
    void d.dismiss();
  });

  const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
  const count = page.getByRole('main').locator('output', { hasText: /\bspans\b/ });

  await page.goto(`${baseURL ?? ''}/index.html#/traces`);
  await expect(count).toHaveText(new RegExp(`^${SPAN_COUNT} spans`));
  // The header row plus one row per span.
  await expect(rows).toHaveCount(SPAN_COUNT + 1);

  // The hostile span name is text, not markup.
  await expect(
    page.getByRole('grid', { name: 'Results' }).getByText(HOSTILE_SPAN_NAME).first(),
  ).toBeVisible();
  expect(await page.locator('img[src="x"]').count()).toBe(0);

  const histogram = page.getByRole('region', { name: 'Spans over time' });
  await expect(histogram).toContainText(`${SPAN_COUNT} spans`);
  await expect(histogram).toContainText(`${ERROR_SPAN_COUNT} errors`);
  const red = page.getByRole('region', { name: 'Requests, errors and latency' });
  await expect(red).toContainText(String(SPAN_COUNT));

  // OTTL mode: the filter narrows the table, histogram, facets and RED strip.
  await page.getByRole('button', { name: 'OTTL' }).click();
  const ottl = page.getByRole('textbox', { name: 'OTTL condition' });
  await ottl.fill(ERRORS);
  await ottl.press('Enter');
  await expect(count).toHaveText(new RegExp(`^${ERROR_SPAN_COUNT} spans`));
  await expect(rows).toHaveCount(ERROR_SPAN_COUNT + 1);
  await expect(histogram).toContainText(`${ERROR_SPAN_COUNT} spans`);
  await expect(red).toContainText(`${ERROR_SPAN_COUNT} (100.0%)`);
  await expect(page.getByTestId(`facet-row:service.name:${SERVICE_B}`)).toBeVisible();
  await expect(page.getByTestId('facet-row:service.name:e2e-service')).toHaveCount(0);
  await expect(page).toHaveURL(/q=/);

  // Reload restores the state.
  await page.reload();
  await expect(count).toHaveText(new RegExp(`^${ERROR_SPAN_COUNT} spans`));
  await expect(rows).toHaveCount(ERROR_SPAN_COUNT + 1);

  // Clear the filter, then a service facet's "only" narrows the rows.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(count).toHaveText(new RegExp(`^${SPAN_COUNT} spans`));
  const row = page.getByTestId(`facet-row:service.name:${SERVICE_B}`);
  await row.hover();
  await page.getByRole('button', { name: `Only ${SERVICE_B}` }).click();
  await expect(count).toHaveText(/^3 spans/);
  await expect(rows).toHaveCount(4);

  // The Status facet's "only error" matches exactly the error spans (the facet value maps to the OTTL enum).
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(count).toHaveText(new RegExp(`^${SPAN_COUNT} spans`));
  await page.getByTestId('facet-row:status.code:error').hover();
  await page.getByRole('button', { name: 'Only error' }).click();
  await expect(count).toHaveText(new RegExp(`^${ERROR_SPAN_COUNT} spans`));
  await expect(rows).toHaveCount(ERROR_SPAN_COUNT + 1);

  expect(problems).toEqual([]);
});

test('every view and the Services page render without errors', async ({ page, baseURL }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

  await page.goto(`${baseURL ?? ''}/index.html#/traces`);
  const view = page.getByRole('combobox', { name: 'View' });
  await expect(view).toBeVisible();
  for (const label of ['Timeseries', 'Top list', 'Bar', 'Table', 'Point plot', 'Treemap', 'Pie', 'List']) {
    await view.selectOption({ label });
    if (label === 'Table') {
      await expect(page.getByRole('table', { name: /grouped by/ })).toBeVisible();
      const groupBy = page.getByRole('combobox', { name: 'Group by' });
      await expect(groupBy).toBeEnabled();
      await groupBy.selectOption('span.name');
      await expect(page.getByRole('table', { name: 'Spans grouped by span.name' })).toBeVisible();
      await groupBy.selectOption({ label: 'Service (default)' });
    } else if (label !== 'List')
      await expect(page.getByRole('img', { name: new RegExp(`^${label} of`) })).toBeVisible();
    else await expect(page.getByRole('grid', { name: 'Results' })).toBeVisible();
  }

  await page.goto(`${baseURL ?? ''}/index.html#/traces/services`);
  const table = page.getByRole('table', { name: 'Services' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table).toContainText(SERVICE_B);
  await table.getByRole('button', { name: SERVICE_B }).click();
  await expect(page).toHaveURL(/#\/traces\?.*q=/);
  await expect(page.getByRole('main').locator('output', { hasText: /\bspans\b/ })).toHaveText(/^3 spans/);

  expect(problems).toEqual([]);
});
