import { LOGS_ONLY_LOG_COUNT } from './fixture.js';
import { expect, test } from './test.js';

const CASES = [
  { report: 'empty', logs: 0 },
  { report: 'logs-only', logs: LOGS_ONLY_LOG_COUNT },
] as const;

for (const { report, logs } of CASES) {
  test(`the ${report} report opens to the no-spans state with its counts`, async ({ page, reportUrl }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

    await page.goto(`${reportUrl(report)}/index.html#/traces`);
    const state = page.getByRole('main').locator('section', { hasText: 'This report has no spans' });
    await expect(state.getByRole('heading', { name: 'This report has no spans' })).toBeVisible();
    await expect(state).toContainText(`${logs} log records and 0 metric data points`);
    // No span table is offered for a report without spans.
    await expect(page.getByRole('grid', { name: 'Results' })).toHaveCount(0);
    expect(problems).toEqual([]);
  });
}
