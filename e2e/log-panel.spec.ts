import { HOSTILE_LOG_TEXT } from './fixture.js';
import { expect, test } from './test.js';

const refOf = (url: string): string => /[?&]log=(\d+\.\d+)/.exec(url)?.[1] ?? '';

test('Log panel: open from a row, reload, j/k, Copy link, Esc, and hostile content', async ({
  page,
  context,
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
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);

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

  // Reload restores the panel.
  await page.reload();
  await expect(page.getByTestId('log-panel')).toBeVisible();
  expect(refOf(page.url())).toBe(ref1);

  // j / k move through the visible rows.
  await page.keyboard.press('j');
  await expect.poll(() => refOf(page.url())).not.toBe(ref1);
  await page.keyboard.press('k');
  await expect.poll(() => refOf(page.url())).toBe(ref1);

  // Surrounding logs switches the tab; Copy link carries log= and ltab=.
  await panel.getByRole('button', { name: 'Surrounding logs' }).click();
  await expect(page).toHaveURL(/ltab=surrounding/);
  await expect(panel.getByRole('grid', { name: 'Results' })).toBeVisible();
  await panel.getByRole('button', { name: 'Copy link' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  if (copied !== null) {
    expect(copied).toContain('log=');
    expect(copied).toContain('ltab=surrounding');
  }

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
