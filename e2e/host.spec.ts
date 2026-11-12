import { fileURLToPath } from 'node:url';
import { fixtureSpanCount, LINKED_LOG_COUNT, METRIC_HIST, METRICS_COUNT, reportDir } from './fixture.js';
import { startHost } from './host-process.js';
import { test as base, expect } from './test.js';

/** What the served viewer must never ask for: the host answers queries, it does not hand out the engine or the data. */
const FORBIDDEN = /\.parquet(\.js)?$|\.b64\.js$|\.wasm$|worker|\/data\/partitions\//;
const SQL_ONLY = /has no SQL form/;

type Host = Awaited<ReturnType<typeof startHost>>;

/** A host over `report` for one worker; at teardown it stops and its stderr holds no warning and no error line. */
function hostFixture(
  report: 'linked' | 'dashboards',
): [
  (args: { playwright: unknown }, use: (h: Host) => Promise<void>) => Promise<void>,
  { scope: 'worker'; timeout: number },
] {
  return [
    async ({ playwright: _unused }: { playwright: unknown }, use: (h: Host) => Promise<void>) => {
      const host = await startHost(fileURLToPath(reportDir(report, 'file')));
      await use(host);
      await host.close();
      const logged = host.stderr();
      // The two refusals are the viewer's own and never reach the host, so nothing it logged is a warning or an error.
      expect(logged).not.toMatch(/\bwarn\b/i);
      expect(logged).not.toMatch(/otel-html error:/);
    },
    { scope: 'worker' as const, timeout: 90_000 },
  ];
}

const test = base.extend<{ served: string; servedDashboards: string }, { host: Host; dashboardsHost: Host }>({
  host: hostFixture('linked'),
  dashboardsHost: hostFixture('dashboards'),
  served: async ({ host, page }, use) => {
    const forbidden = watchForbidden(page);
    await use(`${host.url}/index.html`);
    expect(forbidden, 'the served viewer requested the engine or the data').toEqual([]);
  },
  servedDashboards: async ({ dashboardsHost, page }, use) => {
    const forbidden = watchForbidden(page);
    await use(`${dashboardsHost.url}/index.html`);
    expect(forbidden, 'the served viewer requested the engine or the data').toEqual([]);
  },
});

// One worker per browser project: ten workers each starting hosts and browsers at once exhausts this machine's process
// limit (browsers crash, hosts hang on start), and these tests share the worker-scoped hosts anyway.
// `default`, not `serial`: in order in one worker, but a failure does not skip the rest.
test.describe.configure({ mode: 'default' });

function watchForbidden(page: import('@playwright/test').Page): string[] {
  const forbidden: string[] = [];
  page.on('request', (r) => {
    if (FORBIDDEN.test(new URL(r.url()).pathname)) forbidden.push(r.url());
  });
  return forbidden;
}

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
    // A second page cold-starts the browser engine (WASM and extensions) beside the host; on a busy runner that passes 5 s.
    await expect(table.getByRole('row')).toHaveCount(3, { timeout: 15_000 });
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

test('the Metrics Catalog equals the browser engine over the same report, and a chart draws', async ({
  page,
  served,
  reportUrl,
  browser,
}) => {
  await page.goto(`${served}#/metrics/catalog`);
  await expect(page.getByRole('main')).toContainText(new RegExp(`\\b${METRICS_COUNT} metrics ·`));
  const grid = page.getByRole('grid', { name: 'Results' });
  await expect(grid.getByRole('row')).toHaveCount(METRICS_COUNT + 1);
  const served$ = await grid.textContent();
  await grid.getByRole('row').filter({ hasText: METRIC_HIST }).click();
  await expect(
    page.getByRole('img', { name: new RegExp(`^${METRIC_HIST} · p95: [1-9]\\d* series$`) }),
  ).toBeVisible();

  const local = await browser.newPage();
  try {
    await local.goto(`${reportUrl('linked')}/index.html#/metrics/catalog`);
    const table = local.getByRole('grid', { name: 'Results' });
    await expect(table.getByRole('row')).toHaveCount(METRICS_COUNT + 1, { timeout: 15_000 });
    expect(served$).toBe(await table.textContent());
  } finally {
    await local.close();
  }
});

test('a Metrics Explorer query draws a chart', async ({ page, served }) => {
  const m = {
    queries: [
      {
        id: 'a',
        metric: METRIC_HIST,
        kind: null,
        unit: null,
        show: 'p95',
        by: [],
        where: null,
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
  await expect(
    page.getByRole('img', { name: new RegExp(`^${METRIC_HIST} · p95: [1-9]\\d* series$`) }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the Fusion dashboard renders its timeline and widgets from a served dashboards report', async ({
  page,
  servedDashboards,
}) => {
  await page.goto(`${servedDashboards}#/dashboards/fusion`);
  await expect(page.getByRole('heading', { level: 1, name: 'Fusion' })).toBeVisible();
  const widget = (id: string) => page.locator(`[data-widget="${id}"]`);
  await expect(widget('timeline')).toBeVisible();
  await expect(widget('traces').getByRole('grid', { name: 'Results' }).getByRole('row').nth(1)).toBeVisible();
  await expect(widget('traces')).toContainText(/\d+ traces?/);
  await expect(widget('logs')).toContainText(/\d+ logs?/);
  await expect(widget('metrics')).toContainText('all resources');
  // Drawn, not just present: the timeline's canvas and a metrics chart with at least one series.
  await widget('metrics').scrollIntoViewIfNeeded();
  await expect(widget('timeline').locator('canvas').first()).toBeVisible();
  await expect(
    widget('metrics')
      .getByRole('img', { name: /: [1-9]\d* series$/ })
      .first(),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a row opens the trace panel', async ({ page, served }) => {
  await page.goto(`${served}#/traces?mode=traces`);
  const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
  await expect(rows).not.toHaveCount(0);
  await rows.nth(1).click();
  await expect(page.getByTestId('trace-panel').getByTestId('trace-header')).toBeVisible({ timeout: 15_000 }); // first load (#279)
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
