import { SPAN_COUNT } from './fixture.js';
import { expect, HTTP, isOffMachine, test } from './test.js';
import { runWorkerSql } from './worker-sql.js';

// A format-4 report carries the DuckDB parquet and json extensions beside the engine: with the network gone, or any
// request off this machine aborted, it still opens and shows its spans (the shared guard in e2e/test.ts also fails
// the test on the attempt).
async function expectSpans(
  page: import('@playwright/test').Page,
  baseURL: string | undefined,
): Promise<void> {
  const count = page.getByRole('main').locator('output', { hasText: /\bspans\b/ });
  await page.goto(`${baseURL ?? ''}/index.html#/traces`);
  await expect(count).toHaveText(new RegExp(`^${SPAN_COUNT} spans`));
  await expect(page.getByRole('alert')).toHaveCount(0);
}

test('a report opens with the network off', HTTP, async ({ page, context, baseURL }, testInfo) => {
  if (testInfo.project.name.endsWith('-file')) await context.setOffline(true);
  else
    await context.route(
      (url) => isOffMachine(url.href),
      (route) => route.abort(),
    );
  await expectSpans(page, baseURL);
});

// DuckDB-WASM would fetch ICU from extensions.duckdb.org for a timezone function even with autoload off; the engine
// points its extension repositories where nothing answers, so such a query fails and no request leaves the machine
// (the shared guard in e2e/test.ts fails the test on one).
test(
  'a query that needs a further extension fails and requests nothing off this machine',
  HTTP,
  async ({ page, baseURL }) => {
    await expectSpans(page, baseURL);
    const result = await runWorkerSql(
      page,
      "SELECT timezone('America/New_York', TIMESTAMPTZ '2026-01-01 00:00:00+00')",
    );
    expect(result.type).toBe('ERROR');
    expect(result.message).not.toBe('');
    const reply = await runWorkerSql(page, 'SELECT 1 AS one');
    expect(reply.type).not.toBe('ERROR');
  },
);
