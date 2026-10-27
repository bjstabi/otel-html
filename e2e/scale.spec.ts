import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  perfFactor,
  reportDir,
  SCALE_SERVICES,
  SCALE_SPAN_COUNT,
  SCALE_SPANS_PER_TRACE,
  SCALE_TRACES,
} from './fixture.js';
import { expect, test } from './test.js';

/** Fixed budgets; `OTEL_HTML_PERF_FACTOR` scales them for slow machines, the constants are never loosened. */
const INTERACTIVE_BUDGET_MS = 3000;
const FACET_BUDGET_MS = 150;
/** Timed toggles after one untimed warm-up; the median is compared with the budget. */
const FACET_SAMPLES = 7;

const SERVICE = SCALE_SERVICES[0];
/** Span `j` of a trace belongs to service `j % 8`, so the first service owns spans 0, 8, ..., 48 of each trace. */
const PER_SERVICE = SCALE_TRACES * Math.ceil(SCALE_SPANS_PER_TRACE / SCALE_SERVICES.length);

test(
  '100k spans: the explorer is interactive within 3 s and a facet toggle repaints within 150 ms (median)',
  { tag: '@perf' },
  async ({ page, reportUrl, browserName }, testInfo) => {
    const factor = perfFactor();
    const search = page.getByRole('searchbox', { name: 'Search', exact: true });
    const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
    const count = page.getByRole('main').locator('output', { hasText: /\bspans\b/ });

    // Timed in the page, from navigation start to the frame that paints the first result row. Timing it from the
    // test would add Playwright's assertion polling (retries 100 ms, 250 ms, 500 ms, 1 s apart) to the result.
    await page.addInitScript(() => {
      const mo = new MutationObserver(() => {
        const grid = document.querySelector('[role="grid"][aria-label="Results"]');
        if (grid === null || grid.querySelectorAll('[role="row"]').length < 2) return;
        mo.disconnect();
        requestAnimationFrame(() => {
          (window as { __OH_ROWS_PAINTED__?: number }).__OH_ROWS_PAINTED__ = performance.now();
        });
      });
      mo.observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${reportUrl('scale')}/index.html#/traces`, { waitUntil: 'commit' });
    await expect(rows.nth(1)).toBeVisible({ timeout: 30_000 });
    await search.focus();
    await expect(search).toBeFocused();
    const interactiveMs = Number(
      await (
        await page.waitForFunction(() => (window as { __OH_ROWS_PAINTED__?: number }).__OH_ROWS_PAINTED__)
      ).jsonValue(),
    );
    await expect(count).toHaveText(new RegExp(`^${SCALE_SPAN_COUNT} spans`));

    // A facet toggle is timed from the click to the next frame after the result count changed. The first toggle
    // pays for JIT warm-up, the first OTTL compile and the first chart build, so it is untimed; the budget applies to
    // the median of the toggles after it.
    const toggleMs = (service: string): Promise<number> =>
      page.evaluate(async (svc) => {
        const row = document.querySelector(`[data-testid="facet-row:service.name:${svc}"]`);
        const only = row?.querySelector<HTMLButtonElement>('button[aria-label^="Only "]');
        const out = [...document.querySelectorAll('main output')].find((o) =>
          /\bspans\b/.test(o.textContent ?? ''),
        );
        if (!only || !out) throw new Error('facet row or count output not found');
        const before = out.textContent;
        const t = performance.now();
        return await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('the count never changed')), 10_000);
          const obs = new MutationObserver(() => {
            if (out.textContent === before) return;
            obs.disconnect();
            clearTimeout(timer);
            requestAnimationFrame(() => resolve(performance.now() - t));
          });
          obs.observe(out, { subtree: true, childList: true, characterData: true });
          only.click();
        });
      }, service);
    const clearFilters = async (): Promise<void> => {
      await page.getByRole('button', { name: 'Clear filters' }).click();
      await expect(count).toHaveText(new RegExp(`^${SCALE_SPAN_COUNT} spans`));
      // The cleared view keeps rendering (100k-row query, grid, charts) after its count changes. Wait until the main
      // thread is quiet, so the next timed toggle measures its own latency and not the tail of this one.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const deadline = performance.now() + 5_000;
            let last = performance.now();
            let quiet = 0;
            const tick = (now: number): void => {
              quiet = now - last < 25 ? quiet + 1 : 0;
              last = now;
              if (quiet >= 3 || now > deadline) resolve();
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
    };

    await toggleMs(SERVICE);
    await expect(count).toHaveText(new RegExp(`^${PER_SERVICE} spans`));
    await clearFilters();

    const samples: number[] = [];
    for (let i = 0; i < FACET_SAMPLES; i++) {
      samples.push(await toggleMs(SCALE_SERVICES[i % 2] ?? SERVICE));
      await clearFilters();
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const facetMs = sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
    const worstMs = sorted[sorted.length - 1] ?? Number.POSITIVE_INFINITY;

    const line = `PERF scale ${testInfo.project.name} (${browserName}): interactive ${interactiveMs.toFixed(0)} ms (budget ${INTERACTIVE_BUDGET_MS * factor}), facet repaint median ${facetMs.toFixed(0)} ms, max ${worstMs.toFixed(0)} ms, samples [${samples.map((x) => x.toFixed(0)).join(', ')}] (budget ${FACET_BUDGET_MS * factor}), factor ${factor}\n`;
    process.stdout.write(line);
    testInfo.annotations.push({ type: 'perf', description: line.trim() });
    expect(interactiveMs).toBeLessThan(INTERACTIVE_BUDGET_MS * factor);
    expect(facetMs).toBeLessThan(FACET_BUDGET_MS * factor);
    expect(worstMs).toBeLessThan(2 * FACET_BUDGET_MS * factor);
  },
);

test('a report over the eager budget filters by chunk window and opens a trace through its shard', async ({
  page,
  reportUrl,
}) => {
  const dir = fileURLToPath(reportDir('huge'));
  const spanChunks = readdirSync(`${dir}data/chunks/spans`).filter((f) => f.endsWith('.js'));
  expect(spanChunks.length).toBeGreaterThan(2);

  // Which data files the page loaded. Playwright's request events miss file:// script loads in Firefox, so an init
  // script also records every <script src> the viewer inserts; both witnesses are merged.
  await page.addInitScript(() => {
    const w = window as unknown as { __ohScripts: string[] };
    w.__ohScripts = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLScriptElement && n.src !== '') w.__ohScripts.push(n.src);
    }).observe(document, { childList: true, subtree: true });
  });
  const seen = new Set<string>();
  const note = (url: string): void => {
    const m = /\/data\/((?:traces|chunks\/spans)\/[^/?#]+\.js)(?:[?#].*)?$/.exec(url);
    if (m?.[1] !== undefined) seen.add(m[1]);
  };
  page.on('request', (r) => note(r.url()));
  const loaded = async (): Promise<ReadonlySet<string>> => {
    for (const url of await page.evaluate(() => (window as unknown as { __ohScripts: string[] }).__ohScripts))
      note(url);
    return seen;
  };

  await page.goto(`${reportUrl('huge')}/index.html#/traces`);
  const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
  await expect(rows.nth(1)).toBeVisible({ timeout: 30_000 });

  // Filtering scans chunks on demand and stops once it has enough rows.
  const facet = page.getByTestId(`facet-row:service.name:${SERVICE}`);
  await facet.hover();
  await page.getByRole('button', { name: `Only ${SERVICE}` }).click();
  const partial = page.getByRole('status', { name: 'Partial results' });
  await expect(partial).toContainText(/from \d+ of \d+ chunks/);
  const text = (await partial.textContent()) ?? '';
  const [, scanned, total] = /from (\d+) of (\d+) chunks/.exec(text) ?? [];
  expect(Number(total)).toBe(spanChunks.length);
  expect(Number(scanned)).toBeLessThan(Number(total));
  const chunksAfterFilter = [...(await loaded())].filter((f) => f.startsWith('chunks/')).length;
  expect(chunksAfterFilter).toBeLessThan(spanChunks.length);

  // Opening a trace loads its shard, then exactly the chunks that shard lists.
  await rows.nth(1).click();
  const panel = page.getByTestId('trace-panel');
  await expect(panel.getByTestId('trace-header')).toBeVisible();
  const traceId = /trace=([0-9a-f]{32})/.exec(page.url())?.[1];
  expect(traceId).toBeDefined();
  const shard = (traceId ?? '').slice(0, 2);
  const shardBody = readFileSync(`${dir}data/traces/${shard}.js`, 'utf8');
  const payload = shardBody.slice(shardBody.indexOf(',') + 1, shardBody.lastIndexOf(')'));
  const entry = (JSON.parse(payload) as Record<string, { chunks: string[] }>)[traceId ?? ''];
  expect(entry?.chunks.length).toBeGreaterThan(0);
  const requested = await loaded();
  expect(requested).toContain(`traces/${shard}.js`);
  for (const key of entry?.chunks ?? []) expect(requested).toContain(`${key}.js`);
  expect([...requested].filter((f) => f.startsWith('chunks/')).length).toBeLessThan(spanChunks.length);
});
