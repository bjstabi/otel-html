// Screenshots a report's index.html in light and dark, for the README's <picture>.
//
//   node preview.mjs <report-dir>
//
// Writes <report-dir>/preview-light.png and preview-dark.png (1280x720 at device scale factor 2, so 2560x1440), each to
// a `.tmp` file first and renamed only once both are taken, so a failure leaves the previous images intact. Any failure
// (no index.html, no browser, a report still loading after 30 s) prints `::warning::otel-html preview: <message>` and
// exits 0: a missing preview must not fail a publish.
//
// Environment: PLAYWRIGHT_FROM, the path of a package.json (or any file) in the directory `@playwright/test` is installed under.
// Nothing but Node built-ins is imported here.

import { existsSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const READY_TIMEOUT_MS = 30_000;
const SETTLE_MS = 1_000;
const SCHEMES = ['light', 'dark'];

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: preview.mjs <report-dir>');
  const from = process.env.PLAYWRIGHT_FROM;
  if (!from) throw new Error('PLAYWRIGHT_FROM is not set');
  const index = join(resolve(dir), 'index.html');
  if (!existsSync(index)) throw new Error(`${index} does not exist`);

  const { chromium } = createRequire(resolve(from))('@playwright/test');
  const browser = await chromium.launch();
  const taken = [];
  try {
    for (const colorScheme of SCHEMES) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
        colorScheme,
      });
      const page = await context.newPage();
      await page.goto(pathToFileURL(index).href);
      await page.waitForFunction(
        () =>
          document.querySelector('main') !== null && document.querySelector('[aria-busy="true"]') === null,
        undefined,
        { timeout: READY_TIMEOUT_MS },
      );
      await page.waitForTimeout(SETTLE_MS);
      const tmp = join(resolve(dir), `preview-${colorScheme}.png.tmp`);
      await page.screenshot({ path: tmp, type: 'png' });
      taken.push([tmp, join(resolve(dir), `preview-${colorScheme}.png`)]);
      await context.close();
    }
  } catch (error) {
    for (const [tmp] of taken) rmSync(tmp, { force: true });
    throw error;
  } finally {
    await browser.close();
  }
  for (const [tmp, final] of taken) renameSync(tmp, final);
}

try {
  await main();
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
  process.stdout.write(`::warning::otel-html preview: ${message}\n`);
}
