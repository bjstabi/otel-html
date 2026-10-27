import { LINKED_SPAN, LINKED_TRACE } from './fixture.js';
import { expect, test } from './test.js';

const refOf = (url: string): string => /[?&]log=(\d+\.\d+)/.exec(url)?.[1] ?? '';

test('Log panel Trace tab: the emitting span is outlined, and Open trace lands on the trace with the span', async ({
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

  const base = `${reportUrl('linked')}/index.html`;
  // Find the ref of a log the span emitted by filtering to that span and opening the first row.
  const q = encodeURIComponent(`span_id.string == "${LINKED_SPAN}"`);
  await page.goto(`${base}#/logs?q=${q}`);
  const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
  await expect(rows.nth(1)).toBeVisible();
  await rows.nth(1).click();
  await expect(page).toHaveURL(/[?&]log=\d+\.\d+/);
  const ref = refOf(page.url());
  expect(ref).not.toBe('');

  // The Trace tab straight from the URL.
  await page.goto(`${base}#/logs?log=${ref}&ltab=trace`);
  await page.reload();
  const panel = page.getByTestId('log-panel');
  const tab = panel.getByTestId('log-trace-tab');
  await expect(tab).toBeVisible();
  await expect(tab.getByTestId('flame-graph')).toBeVisible();
  await expect(tab.getByTestId('flame-outline')).toContainText('payments');
  await expect(tab.getByTestId('flame-outline')).toContainText('emitted this log');

  // Open trace goes to the trace page with the span selected.
  await tab.getByRole('button', { name: /Open trace/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/traces/trace/${LINKED_TRACE}`));
  await expect(page).toHaveURL(new RegExp(`span=${LINKED_SPAN}`));
  await expect(page.getByTestId('log-panel')).toHaveCount(0);

  expect(problems).toEqual([]);
});
