import { ENGINE_VERSION } from '../src/format/engine.js';
import { SPAN_COUNT } from './fixture.js';
import { expect, HTTP, test } from './test.js';

declare global {
  interface Window {
    __order?: string[];
  }
}

// The engine files (worker, wasm, the two extensions) are fetched once each, never twice, and the navigation shows
// while the engine starts: the page (a `main`) is up while the loading line still shows, and the line then leaves.
test(
  'the engine files are requested once each and the page shows before the engine is ready',
  HTTP,
  async ({ page, baseURL }, testInfo) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
    page.on('response', (r) => {
      if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
    });

    const engineRequests = new Map<string, number>();
    page.on('request', (r) => {
      const url = r.url();
      if (/\/assets\/.*(duckdb|duckdb_extension)/.test(url))
        engineRequests.set(url, (engineRequests.get(url) ?? 0) + 1);
    });

    await page.addInitScript(() => {
      const order: string[] = [];
      window.__order = order;
      // The first `main` is recorded as `main-while-loading` when the loading line is still there (the page frame
      // rendered before the engine), `main` otherwise; `ready` once a `main` exists and the line is gone.
      const scan = (): void => {
        const main = document.querySelector('main') !== null;
        const loading = document.querySelector('[aria-label="Loading the report"]') !== null;
        if (main && order.length === 0) order.push(loading ? 'main-while-loading' : 'main');
        if (main && !loading && !order.includes('ready')) order.push('ready');
      };
      const observer = new MutationObserver(scan);
      const start = (): void => {
        observer.observe(document.documentElement, { childList: true, subtree: true });
        scan();
      };
      if (document.documentElement) start();
      else {
        const waiter = new MutationObserver(() => {
          if (document.documentElement) {
            waiter.disconnect();
            start();
          }
        });
        waiter.observe(document, { childList: true });
      }
    });

    await page.goto(`${baseURL ?? ''}/index.html#/traces`);
    await expect(page.getByRole('main').locator('output', { hasText: /\bspans\b/ })).toHaveText(
      new RegExp(`^${SPAN_COUNT} spans`),
    );

    expect(await page.evaluate(() => window.__order)).toEqual(['main-while-loading', 'ready']);
    if (testInfo.project.name.endsWith('-http')) {
      expect(engineRequests.size).toBe(4);
      expect([...engineRequests.values()]).toEqual([1, 1, 1, 1]);
    } else {
      // Firefox does not report file:// script requests, so with none observed this check is vacuous; whatever
      // was observed must not repeat.
      expect([...engineRequests.values()].every((n) => n === 1)).toBe(true);
    }
    // A reload reads the engine files from cache storage (the viewer stored them after the first load), so no
    // request is made. Only Chromium runs the -http projects; WebKit would need a skip here (http://127.0.0.1 is
    // not a secure context there, so `caches` is unavailable).
    if (testInfo.project.name.endsWith('-http')) {
      // The store is fire-and-forget after the load: wait until it finished before navigating away.
      await expect
        .poll(
          () =>
            page.evaluate(
              async (name) => (await (await caches.open(name)).keys()).length,
              `oh-engine-${ENGINE_VERSION}`,
            ),
          { timeout: 15_000 },
        )
        .toBe(4);
      await page.reload();
      await expect(page.getByRole('main').locator('output', { hasText: /\bspans\b/ })).toHaveText(
        new RegExp(`^${SPAN_COUNT} spans`),
      );
      expect([...engineRequests.values()], 'a reload serves the engine files from cache storage').toEqual([
        1, 1, 1, 1,
      ]);
    }
    expect(problems).toEqual([]);
  },
);
