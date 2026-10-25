import { HOSTILE_ROOT_SPAN, HOSTILE_TRACE_ID } from './fixture.js';
import { expect, hostileTest as test } from './test.js';

declare global {
  interface Window {
    __pwned?: number;
  }
}

test('hostile content renders as text: explorer, panel and span section', async ({ page, baseURL }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('dialog', (d) => {
    problems.push(`unexpected dialog: ${d.message()}`);
    void d.dismiss();
  });

  // Explorer.
  await page.goto(`${baseURL ?? ''}/index.html#/traces`);
  await expect(page.getByRole('grid', { name: 'Results' })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Results' }).getByRole('row')).not.toHaveCount(1);

  // Panel with the root span selected.
  await page.goto(`${baseURL ?? ''}/index.html#/traces?trace=${HOSTILE_TRACE_ID}&span=${HOSTILE_ROOT_SPAN}`);
  const panel = page.getByTestId('trace-panel');
  await expect(panel.getByTestId('trace-header')).toContainText(HOSTILE_TRACE_ID);
  const section = panel.getByRole('region', { name: 'Span details' });
  const exceptions = section.getByTestId('span-exceptions');
  await expect(exceptions).toBeVisible();
  // The literal markup is visible as text, never parsed into elements.
  await expect(section).toContainText('<img src=x');
  await expect(section).toContainText('</script>');
  expect(await page.locator('img[src="x"]').count()).toBe(0);

  // The stack trace is collapsed, then expands to a 10 KB string without breaking layout.
  const toggle = exceptions.getByRole('button', { name: 'Stack trace' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // Events, links and resource tabs, with the link target absent from this report.
  await section.getByRole('tab', { name: 'Events' }).click();
  await expect(section.getByLabel('Span events')).toContainText('exception');
  await section.getByRole('tab', { name: 'Links' }).click();
  await expect(section.getByText('not in this report')).toBeVisible();
  await section.getByRole('tab', { name: 'Resource' }).click();
  await expect(section.getByRole('region', { name: 'Schema URLs' })).toContainText('</script>');
  await section.getByRole('tab', { name: 'Overview' }).click();

  // The deeply nested kvlist is a collapsible tree.
  await expect(section.getByRole('tree', { name: 'Value of custom.deep' })).toBeVisible();

  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(problems).toEqual([]);
});
