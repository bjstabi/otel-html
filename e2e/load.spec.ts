import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Page } from '@playwright/test';
import { perfFactor } from './fixture.js';
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
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveFolder(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep)) return void res.writeHead(404).end();
    stat(file).then(
      (s) => {
        if (!s.isFile()) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        createReadStream(file).pipe(res);
      },
      () => res.writeHead(404).end(),
    );
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return fail(new Error('no TCP address'));
      ok({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

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
  let served: { server: Server; origin: string } | undefined;

  test.beforeAll(async () => {
    if (reportRoot !== undefined) served = await serveFolder(resolve(reportRoot));
  });
  test.afterAll(async () => {
    const server = served?.server;
    if (server !== undefined) await new Promise<void>((done) => server.close(() => done()));
  });

  for (const landing of ['traces', 'logs'] as const) {
    test(`the ${landing} landing is interactive within 3 s (median)`, async ({
      page,
      browserName,
    }, testInfo) => {
      if (served === undefined) throw new Error('the report server is not running');
      const factor = perfFactor();
      const samples = await landingMs(page, `${served.origin}/index.html#/${landing}`);
      const ms = median(samples);
      const line = `PERF load ${landing} landing ${testInfo.project.name} (${browserName}): median ${ms.toFixed(0)} ms, samples [${samples.map((x) => x.toFixed(0)).join(', ')}] (budget ${INTERACTIVE_BUDGET_MS * factor}), factor ${factor}`;
      process.stdout.write(`${line}\n`);
      testInfo.annotations.push({ type: 'perf', description: line });
      expect(ms).toBeLessThan(INTERACTIVE_BUDGET_MS * factor);
    });
  }
});
