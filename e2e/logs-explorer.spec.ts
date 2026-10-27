import { LINKED_DECLINED_COUNT, LINKED_LOG_COUNT, LINKED_WARN_PLUS_COUNT } from './fixture.js';
import { expect, test } from './test.js';

test('Logs explorer: severity and text filters, patterns, brush, sidebar and carry-over', async ({
  page,
  reportUrl,
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

  const main = page.getByRole('main');
  const count = main.locator('output', { hasText: /\blogs\b/ });
  const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');

  await page.goto(`${reportUrl('linked')}/index.html#/logs`);
  await expect(page.getByRole('heading', { name: 'Logs', level: 1 })).toBeVisible();
  await expect(count).toHaveText(new RegExp(`^${LINKED_LOG_COUNT} logs`));
  const histogram = page.getByRole('region', { name: /logs by severity$/ });
  await expect(histogram).toContainText(`${LINKED_LOG_COUNT} logs`);

  // Severity "And above" WARN keeps warn, error and fatal.
  await page.getByTestId('facet-row:severity:warn').hover();
  await page.getByRole('button', { name: 'And above warn' }).click();
  await expect(count).toHaveText(new RegExp(`^${LINKED_WARN_PLUS_COUNT} logs`));
  await expect(page).toHaveURL(/q=/);

  // Free text narrows to the declined-card lines; all of them fit, so the grid holds exactly those rows.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(count).toHaveText(new RegExp(`^${LINKED_LOG_COUNT} logs`));
  const search = page.getByRole('searchbox', { name: 'Search', exact: true });
  await search.fill('declined');
  await search.press('Enter');
  await expect(count).toHaveText(new RegExp(`^${LINKED_DECLINED_COUNT} logs`));
  await expect(rows).toHaveCount(LINKED_DECLINED_COUNT + 1);

  // Patterns and back.
  await page.getByRole('button', { name: 'Patterns', exact: true }).click();
  await expect(page).toHaveURL(/mode=patterns/);
  await expect(main.locator('output', { hasText: /\bpatterns?\b/ })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Results' })).toContainText('card declined');
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await expect(page).not.toHaveURL(/mode=/);
  await expect(count).toHaveText(new RegExp(`^${LINKED_DECLINED_COUNT} logs`));

  // Brushing the histogram writes the window to the URL.
  await search.fill('');
  await search.press('Enter');
  const brush = histogram.getByRole('group', { name: 'Time brush' });
  const box = await brush.boundingBox();
  if (box === null) throw new Error('the brush is laid out');
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page).toHaveURL(/[?&]t=\d+~\d+/);

  // Sidebar Logs > Patterns lands on patterns mode.
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await nav.getByRole('region', { name: 'Logs' }).getByRole('link', { name: 'Patterns' }).click();
  await expect(page).toHaveURL(/#\/logs\?.*mode=patterns/);
  await expect(page.getByRole('button', { name: 'Patterns', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // A resource filter survives g t then g l.
  await nav.getByRole('region', { name: 'Logs' }).getByRole('link', { name: 'Explorer' }).click();
  const paymentsRow = page.getByTestId('facet-row:service.name:payments');
  await paymentsRow.hover();
  await paymentsRow.getByRole('button', { name: 'Only payments' }).click();
  await expect(page).toHaveURL(/q=[^&]*service\.name/);
  await expect(count).not.toHaveText(new RegExp(`^${LINKED_LOG_COUNT} logs`));
  const payments = (await count.textContent())?.match(/^(\d+) logs/)?.[1];
  expect(Number(payments)).toBeLessThan(LINKED_LOG_COUNT);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/#\/traces\?.*q=[^&]*service\.name/);
  await page.keyboard.press('g');
  await page.keyboard.press('l');
  await expect(page).toHaveURL(/#\/logs\?.*q=[^&]*service\.name/);
  await expect(count).toHaveText(new RegExp(`^${payments} logs`));

  expect(problems).toEqual([]);
});
