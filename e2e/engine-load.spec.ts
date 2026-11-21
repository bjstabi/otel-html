import { SPAN_COUNT } from './fixture.js';
import { expect, HTTP, test } from './test.js';

declare global {
  interface Window {
    __order?: string[];
  }
}

// The engine files (worker, wasm, the two extensions) are fetched once each, never twice, and the navigation shows
// while the engine starts: a `nav` is in the DOM before the first `main`.
test(
  'the engine files are requested once each and the navigation shows before the page',
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
      const seen = new Set<string>();
      const scan = (): void => {
        for (const tag of ['nav', 'main']) {
          if (!seen.has(tag) && document.querySelector(tag)) {
            seen.add(tag);
            order.push(tag);
          }
        }
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

    const counts = [...engineRequests.values()];
    if (testInfo.project.name.endsWith('-http')) {
      expect([...engineRequests.keys()].map((u) => u.split('/').pop()).sort()).toHaveLength(4);
      expect(counts).toEqual([1, 1, 1, 1]);
    } else {
      // Firefox does not report file:// script requests; whatever was observed must not repeat.
      expect(counts.every((n) => n === 1)).toBe(true);
    }
    expect(await page.evaluate(() => window.__order)).toEqual(['nav', 'main']);
    expect(problems).toEqual([]);
  },
);
