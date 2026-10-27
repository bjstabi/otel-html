import { DANGLING_SPAN_LOG_TEXT, LINKED_SPAN, LINKED_TRACE } from './fixture.js';
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

  // The Trace tab from a cold load of the URL (the reload makes the hash-only goto a real load).
  await page.goto(`${base}#/logs?log=${ref}&ltab=trace`);
  await page.reload();
  const panel = page.getByTestId('log-panel');
  const tab = panel.getByTestId('log-trace-tab');
  await expect(tab).toBeVisible();
  await expect(tab.getByTestId('flame-graph')).toBeVisible();
  await expect(tab.getByTestId('flame-outline')).toContainText('payments');
  await expect(tab.getByTestId('flame-outline')).toContainText('emitted this log');

  // Clicking a span is one history entry: Back returns to the log panel.
  await tab.getByRole('button', { name: 'Waterfall' }).click();
  await tab.getByRole('treeitem').filter({ hasText: 'payments' }).first().click();
  await expect(page).toHaveURL(/[?&]trace=/);
  await expect(page).not.toHaveURL(/[?&]log=/);
  await page.goBack();
  await expect(page).toHaveURL(/[?&]log=\d+\.\d+/);
  await expect(page.getByTestId('log-trace-tab')).toBeVisible();

  // Open trace goes to the trace page with the span selected.
  await tab.getByRole('button', { name: /Open trace/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/traces/trace/${LINKED_TRACE}`));
  await expect(page).toHaveURL(new RegExp(`span=${LINKED_SPAN}`));
  await expect(page.getByTestId('log-panel')).toHaveCount(0);

  expect(problems).toEqual([]);
});

test.describe('Logs tabs in the trace and span panels', () => {
  const base = (reportUrl: (name: 'linked') => string): string => `${reportUrl('linked')}/index.html`;

  test('the trace Logs tab lists the trace logs; a row click opens the log and Back returns', async ({
    page,
    reportUrl,
  }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

    await page.goto(`${base(reportUrl)}#/traces?trace=${LINKED_TRACE}&tab=logs`);
    await page.reload();
    const tab = page.getByTestId('trace-logs-tab');
    await expect(tab).toBeVisible();
    await expect(tab.getByRole('row').nth(1)).toBeVisible();
    await expect(tab).toContainText(/\d+ logs/);

    // The span Logs tab lists the span's logs (>= 3), and never the dangling-span log of the same trace.
    await page.goto(`${base(reportUrl)}#/traces?trace=${LINKED_TRACE}&tab=logs&span=${LINKED_SPAN}`);
    await page.getByRole('tablist', { name: 'Span views' }).getByRole('tab', { name: 'Logs' }).click();
    const spanLogs = page.getByTestId('span-logs-tab');
    await expect(spanLogs).toBeVisible();
    await expect(spanLogs.getByRole('row').nth(3)).toBeVisible();
    await expect(spanLogs).not.toContainText(DANGLING_SPAN_LOG_TEXT);

    // A row click lands on the Logs Explorer with that log's panel open; Back returns to the trace panel.
    await tab.getByRole('row').nth(1).click();
    await expect(page).toHaveURL(/#\/logs\?/);
    await expect(page).toHaveURL(/[?&]log=\d+\.\d+/);
    await expect(page.getByTestId('log-panel')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('trace-panel')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`trace=${LINKED_TRACE}`));

    expect(problems).toEqual([]);
  });

  test('round trip: log panel, Trace tab, span, span Logs tab lists the original log', async ({
    page,
    reportUrl,
  }) => {
    const url = base(reportUrl);
    const q = encodeURIComponent(`span_id.string == "${LINKED_SPAN}"`);
    await page.goto(`${url}#/logs?q=${q}`);
    const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
    await expect(rows.nth(1)).toBeVisible();
    const original = ((await rows.nth(1).textContent()) ?? '').trim();
    expect(original).not.toBe('');
    await rows.nth(1).click();
    await expect(page).toHaveURL(/[?&]log=\d+\.\d+/);
    const ref = refOf(page.url());
    await expect(page.getByTestId('log-panel')).toBeVisible();

    await page.goto(`${url}#/logs?q=${q}&log=${ref}&ltab=trace`);
    await page.reload();
    const trace = page.getByTestId('log-trace-tab');
    await expect(trace.getByTestId('flame-graph')).toBeVisible();
    await trace.getByRole('button', { name: 'Waterfall' }).click();
    await trace.getByRole('treeitem').filter({ hasText: 'payments' }).first().click();
    await expect(page).toHaveURL(/[?&]trace=/);
    await expect(page.getByTestId('trace-panel')).toBeVisible();

    await page.getByRole('tablist', { name: 'Span views' }).getByRole('tab', { name: 'Logs' }).click();
    const spanLogs = page.getByTestId('span-logs-tab');
    await expect(spanLogs).toBeVisible();
    await expect(spanLogs).toContainText(original);
  });
});
