import { HOSTILE_LOG_TEXT } from './fixture.js';
import { expect, test } from './test.js';

const refOf = (url: string): string => /[?&]log=(\d+\.\d+)/.exec(url)?.[1] ?? '';

test('Log panel: open from a row, reload, j/k, Copy link, Esc, and hostile content', async ({
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
  // A stub clipboard records what CopyLink writes, so the assertion is the same under file: and http:.
  await page.addInitScript(() => {
    const w: Window & { __copied?: string } = window;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t: string): Promise<void> => {
          w.__copied = t;
          return Promise.resolve();
        },
      },
    });
  });

  await page.goto(`${reportUrl('linked')}/index.html#/logs`);
  const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
  await expect(rows.nth(1)).toBeVisible();
  const panel = page.getByTestId('log-panel');

  // Click the first row: the URL carries log= and the panel opens.
  await rows.nth(1).click();
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/[?&]log=\d+\.\d+/);
  const ref1 = refOf(page.url());
  expect(ref1).not.toBe('');
  await expect(panel.getByRole('tab', { name: 'Attributes' })).toBeVisible();

  // The panel renders from log= before the query delivers rows; j/k need the rows, so wait for the selected row.
  const selectedRow = page
    .getByRole('grid', { name: 'Results' })
    .locator('[role="row"][data-selected="true"]');

  // Reload restores the panel.
  await page.reload();
  await expect(page.getByTestId('log-panel')).toBeVisible();
  expect(refOf(page.url())).toBe(ref1);
  await expect(selectedRow).toBeVisible();

  // j / k move through the visible rows.
  await page.keyboard.press('j');
  await expect.poll(() => refOf(page.url())).not.toBe(ref1);
  await expect(selectedRow).toBeVisible();
  await page.keyboard.press('k');
  await expect.poll(() => refOf(page.url())).toBe(ref1);

  // Surrounding logs switches the tab; Copy link carries log= and ltab=.
  await panel.getByRole('button', { name: 'Surrounding logs' }).click();
  await expect(page).toHaveURL(/ltab=surrounding/);
  await expect(panel.getByRole('grid', { name: 'Results' })).toBeVisible();
  await panel.getByRole('button', { name: 'Copy link' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __copied?: string }).__copied ?? ''))
    .toMatch(/log=\d+\.\d+.*ltab=surrounding|ltab=surrounding.*log=\d+\.\d+/);

  // Esc closes the panel and clears log= only.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('log-panel')).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]log=/);

  // The hostile log renders its text; no dialog fires and no img element appears.
  const search = page.getByRole('searchbox', { name: 'Search', exact: true });
  await search.fill('onerror');
  await search.press('Enter');
  await expect(rows).toHaveCount(2);
  await rows.nth(1).click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(HOSTILE_LOG_TEXT);
  expect(await panel.locator('img').count()).toBe(0);

  expect(problems).toEqual([]);
});
