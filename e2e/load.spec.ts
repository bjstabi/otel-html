import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { perfFactor } from './fixture.js';
import { serve } from './static-server.js';
import { expect, test } from './test.js';

/**
 * The viewer on a report the receiver load test wrote (`scripts/load-receiver.ts`): both landings must be interactive.
 * Skipped unless OTEL_HTML_LOAD_REPORT names the report folder, which this spec serves itself.
 */
const REPORT_ENV = 'OTEL_HTML_LOAD_REPORT';
const reportRoot = process.env[REPORT_ENV];
const INTERACTIVE_BUDGET_MS = 3000;
/** Timed loads after one untimed warm-up load; the median is compared with the budget. */
const LOAD_SAMPLES = 3;
const GRID = '[role="grid"][aria-label="Results"]';

/**
 * Milliseconds from navigation start to the frame in which the page's result grid has rows, for each of
 * `LOAD_SAMPLES` loads after an untimed first one. Timed in the page, not by Playwright's polling assertions.
 */
async function landingMs(page: Page, url: string): Promise<number[]> {
  await page.addInitScript((grid) => {
    const w = window as { __OH_LOAD_READY__?: number };
    const mo = new MutationObserver(() => {
      const g = document.querySelector(grid);
      if (g === null || g.querySelectorAll('[role="row"]').length < 2) return;
      mo.disconnect();
      requestAnimationFrame(() => {
        w.__OH_LOAD_READY__ = performance.now();
      });
    });
    mo.observe(document, { childList: true, subtree: true });
  }, GRID);
  const samples: number[] = [];
  for (let i = 0; i <= LOAD_SAMPLES; i++) {
    if (i === 0) await page.goto(url, { waitUntil: 'commit' });
    else await page.reload({ waitUntil: 'commit' });
    const ms = Number(
      await (
        await page.waitForFunction(() => (window as { __OH_LOAD_READY__?: number }).__OH_LOAD_READY__, null, {
          timeout: 60_000,
        })
      ).jsonValue(),
    );
    if (i > 0) samples.push(ms);
  }
  return samples;
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
}

test.describe('report written by the receiver load test', () => {
  test.skip(reportRoot === undefined, `${REPORT_ENV} is not set`);
  let served: { port: number; close(): Promise<void> } | undefined;

  test.beforeAll(async () => {
    if (reportRoot !== undefined) served = await serve([{ prefix: '', root: resolve(reportRoot) }]);
  });
  test.afterAll(async () => {
    await served?.close();
  });

  for (const landing of ['traces', 'logs'] as const) {
    test(`the ${landing} landing is interactive within 3 s (median)`, async ({
      page,
      browserName,
    }, testInfo) => {
      if (served === undefined) throw new Error('the report server is not running');
      const factor = perfFactor();
      const samples = await landingMs(page, `http://127.0.0.1:${served.port}/index.html#/${landing}`);
      const ms = median(samples);
      const line = `PERF load ${landing} landing ${testInfo.project.name} (${browserName}): median ${ms.toFixed(0)} ms, samples [${samples.map((x) => x.toFixed(0)).join(', ')}] (budget ${INTERACTIVE_BUDGET_MS * factor}), factor ${factor}`;
      process.stdout.write(`${line}\n`);
      testInfo.annotations.push({ type: 'perf', description: line });
      expect(ms).toBeLessThan(INTERACTIVE_BUDGET_MS * factor);
    });
  }
});
