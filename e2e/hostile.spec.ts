import {
  DASHBOARDS_HOSTILE_DEFAULT,
  DASHBOARDS_HOSTILE_DESCRIPTION,
  DASHBOARDS_HOSTILE_TITLE,
  HOSTILE_METRIC_ATTR,
  HOSTILE_METRIC_ATTR_VALUE,
  HOSTILE_METRIC_NAME,
  HOSTILE_METRIC_UNIT,
  HOSTILE_ROOT_SPAN,
  HOSTILE_TRACE_ID,
} from './fixture.js';
import { watchProblems } from './metric-chart.js';
import { expect, test as linkedTest, hostileTest as test } from './test.js';

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

linkedTest(
  'a hostile metric name renders as text: Catalog, Explorer picker and chart card',
  async ({ page, reportUrl }) => {
    const problems = watchProblems(page);
    await page.goto(`${reportUrl('linked')}/index.html#/metrics/catalog`);
    await page.getByRole('searchbox', { name: 'Filter metrics' }).fill('</script>');
    const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText(HOSTILE_METRIC_NAME);

    await rows.nth(1).click();
    await expect(page.getByRole('button', { name: 'Metric of a' })).toContainText(HOSTILE_METRIC_NAME);
    // Split by the markup attribute, so its value names the line.
    await page.getByRole('button', { name: 'By of a' }).click();
    await page.getByRole('checkbox', { name: `attributes["${HOSTILE_METRIC_ATTR}"]` }).check();
    await page.keyboard.press('Escape');
    // A gauge: the card is titled with its default show, avg.
    const card = page.getByRole('region', { name: `${HOSTILE_METRIC_NAME} · avg` });
    await expect(card.getByRole('heading')).toContainText(HOSTILE_METRIC_NAME);
    const chart = card.getByRole('img', { name: /: 1 series$/ });
    await expect(chart).toBeVisible();
    // Hovering the chart shows its HTML tooltip (the one place chart text reaches the DOM): the markup in the series
    // name and in the unit after the value is text, never an element.
    await chart.hover();
    const tooltip = card.getByText(`a · avg · ${HOSTILE_METRIC_ATTR_VALUE}: 0.5 ${HOSTILE_METRIC_UNIT}`, {
      exact: true,
    });
    await expect(tooltip).toBeVisible();
    expect(await card.locator('img').count()).toBe(0);

    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(problems).toEqual([]);
  },
);

linkedTest(
  'a hostile dashboard title, description and variable default render as text',
  async ({ page, reportUrl }) => {
    const problems = watchProblems(page);
    const base = `${reportUrl('dashboards-hostile')}/index.html`;

    await page.goto(`${base}#/dashboards`);
    const row = page.getByRole('table').getByRole('row').nth(2);
    await expect(row).toContainText(DASHBOARDS_HOSTILE_TITLE);
    await expect(row).toContainText(DASHBOARDS_HOSTILE_DESCRIPTION);

    // `g d` opens the default dashboard, the hostile one.
    await page.keyboard.press('g');
    await page.keyboard.press('d');
    await expect(page).toHaveURL(/#\/dashboards\/hostile/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(DASHBOARDS_HOSTILE_TITLE);
    // The variable default carries a quote and a backslash into the filter; it is a value, not syntax.
    const service = page.getByRole('combobox', { name: 'service.name' });
    await expect(service).toContainText(DASHBOARDS_HOSTILE_DEFAULT);
    await expect(page.locator('[data-widget="w1"]')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    expect(await page.locator('img[src="x"]').count()).toBe(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(problems).toEqual([]);
  },
);
