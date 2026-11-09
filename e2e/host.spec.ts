import { fileURLToPath } from 'node:url';
import { fixtureSpanCount, LINKED_LOG_COUNT, METRIC_HIST, METRICS_COUNT, reportDir } from './fixture.js';
import { startHost } from './host-process.js';
import { test as base, expect } from './test.js';

/** What the served viewer must never ask for: the host answers queries, it does not hand out the engine or the data. */
const FORBIDDEN = /\.parquet(\.js)?$|\.wasm$|worker|\/data\/partitions\//;
const SQL_ONLY = /has no SQL form/;

const test = base.extend<{ served: string }, { host: Awaited<ReturnType<typeof startHost>> }>({
  host: [
    async ({ playwright: _unused }, use) => {
      const host = await startHost(fileURLToPath(reportDir('linked', 'file')));
      await use(host);
      await host.close();
      // The two refusals are the viewer's own and never reach the host, so nothing it logged is a warning.
      expect(host.stderr()).not.toMatch(/\bwarn\b/i);
    },
    { scope: 'worker' },
  ],
  served: async ({ host, page }, use) => {
    const forbidden: string[] = [];
    page.on('request', (r) => {
      if (FORBIDDEN.test(new URL(r.url()).pathname)) forbidden.push(r.url());
    });
    await use(`${host.url}/index.html`);
    expect(forbidden, 'the served viewer requested the engine or the data').toEqual([]);
  },
});

const spanCount = (page: import('@playwright/test').Page) =>
  page.getByRole('main').locator('output', { hasText: /\bspans\b/ });

test('Traces explorer and the Services page equal the browser engine over the same report', async ({
  page,
  served,
  reportUrl,
  browser,
}) => {
  await page.goto(`${served}#/traces`);
  await expect(spanCount(page)).toHaveText(new RegExp(`^${fixtureSpanCount('linked')} spans`));

  await page.goto(`${served}#/traces/services`);
  const services = page.getByRole('table', { name: 'Services' });
  await expect(services.getByRole('row')).toHaveCount(3);
  const served$ = await services.textContent();

  // The same page over file://, from the browser's own engine.
  const local = await browser.newPage();
  try {
    await local.goto(`${reportUrl('linked')}/index.html#/traces/services`);
    const table = local.getByRole('table', { name: 'Services' });
    await expect(table.getByRole('row')).toHaveCount(3);
    expect(served$).toBe(await table.textContent());
  } finally {
    await local.close();
  }
});

test('Logs explorer shows every log', async ({ page, served }) => {
  await page.goto(`${served}#/logs`);
  await expect(page.getByRole('main').locator('output', { hasText: /\blogs\b/ })).toHaveText(
    new RegExp(`^${LINKED_LOG_COUNT} logs`),
  );
});

test('the Metrics Catalog lists the metrics and a chart draws', async ({ page, served }) => {
  await page.goto(`${served}#/metrics/catalog`);
  await expect(page.getByRole('main')).toContainText(new RegExp(`\\b${METRICS_COUNT} metrics ·`));
  const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
  await expect(rows).toHaveCount(METRICS_COUNT + 1);
  await rows.filter({ hasText: METRIC_HIST }).click();
  await expect(
    page.getByRole('img', { name: new RegExp(`^${METRIC_HIST} · p95: [1-9]\\d* series$`) }),
  ).toBeVisible();
});

test('a row opens the trace panel', async ({ page, served }) => {
  await page.goto(`${served}#/traces?mode=traces`);
  const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
  await expect(rows).not.toHaveCount(0);
  await rows.nth(1).click();
  await expect(page.getByTestId('trace-panel').getByTestId('trace-header')).toBeVisible();
});

test('a filter with no SQL form shows the served refusal, not "evaluated in the browser"', async ({
  page,
  served,
}) => {
  await page.goto(`${served}#/traces`);
  await expect(spanCount(page)).toBeVisible();
  await page.getByRole('button', { name: 'OTTL' }).click();
  const ottl = page.getByRole('textbox', { name: 'OTTL condition' });
  await ottl.fill('Len(name) > 2');
  await ottl.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: SQL_ONLY })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Evaluated in the browser' })).toHaveCount(0);
});

test('a metric where with no SQL form shows the same refusal', async ({ page, served }) => {
  const m = {
    queries: [
      {
        id: 'a',
        metric: METRIC_HIST,
        kind: null,
        unit: null,
        show: 'p95',
        by: [],
        where: 'Len(attributes["k"]) > 1',
        fn: [],
        alias: null,
        hidden: false,
      },
    ],
    formulas: [],
    display: 'lines',
    scale: 'linear',
    split: false,
    exemplars: false,
  };
  await page.goto(`${served}#/metrics?m=${encodeURIComponent(JSON.stringify(m))}`);
  await expect(page.getByRole('alert').filter({ hasText: SQL_ONLY })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Evaluated in the browser' })).toHaveCount(0);
});
