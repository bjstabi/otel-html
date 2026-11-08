// Screenshots a report's index.html in light and dark, for the README's <picture>.
//
//   node preview.mjs <site-dir> <channel>
//
// The report is a `site`-format report (its viewer files live in a shared `assets/<version>/` folder beside the
// channel folders, read over HTTP with Range requests), so the site root is served by a loopback static server for
// the length of the run and the page is opened at http://127.0.0.1:<port>/<channel>/index.html. The server always closes.
//
// Writes <site-dir>/<channel>/preview-light.png and preview-dark.png (1280x720 at device scale factor 2, so 2560x1440), each to
// a `.tmp` file first and renamed only once both are taken, so a failure leaves the previous images intact. Any failure
// (no index.html, no browser, a report still loading after 30 s, a page that shows an alert such as a report that failed to load) prints `::warning::otel-html preview: <message>` and
// exits 0: a missing preview must not fail a publish.
//
// Environment: PLAYWRIGHT_FROM, the path of a package.json (or any file) in the directory `@playwright/test` is installed under.
// Nothing but Node built-ins is imported here.

import { createReadStream, existsSync, renameSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve, sep } from 'node:path';

const READY_TIMEOUT_MS = 30_000;
const SETTLE_MS = 1_000;
const SCHEMES = ['light', 'dark'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.parquet': 'application/vnd.apache.parquet',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
};

// A copy of the range logic of e2e/static-server.ts (the action has no build step).
/** A single `bytes=a-b`, `bytes=a-` or `bytes=-n` range of a file of `size` bytes; null when absent or not understood. */
function parseRange(header, size) {
  const suffix = /^bytes=-(\d+)$/.exec(header ?? '');
  if (suffix !== null) {
    const n = Number(suffix[1]);
    return n === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const m = /^bytes=(\d+)-(\d*)$/.exec(header ?? '');
  if (m === null) return null;
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || end < start ? 'unsatisfiable' : { start, end };
}

/** Serves `root` over HTTP on a free loopback port (listening on 0); answers `Range` (206, 416) and `HEAD`. */
async function serve(root) {
  const server = createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const head = req.method === 'HEAD';
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep)) {
      res.writeHead(404).end();
      return;
    }
    stat(file).then(
      (s) => {
        if (!s.isFile()) {
          res.writeHead(404).end();
          return;
        }
        const base = {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          'accept-ranges': 'bytes',
        };
        const range = head ? null : parseRange(req.headers.range, s.size);
        if (range === 'unsatisfiable') {
          res.writeHead(416, { ...base, 'content-range': `bytes */${s.size}`, 'content-length': 0 }).end();
        } else if (range === null) {
          res.writeHead(200, { ...base, 'content-length': s.size });
          if (head) res.end();
          else createReadStream(file).pipe(res);
        } else {
          res.writeHead(206, {
            ...base,
            'content-range': `bytes ${range.start}-${range.end}/${s.size}`,
            'content-length': range.end - range.start + 1,
          });
          createReadStream(file, range).pipe(res);
        }
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('the preview server has no TCP address');
  return {
    port: address.port,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

async function main() {
  const site = process.argv[2];
  const channel = process.argv[3];
  if (!site || !channel) throw new Error('usage: preview.mjs <site-dir> <channel>');
  const root = resolve(site);
  const dir = join(root, channel);
  const from = process.env.PLAYWRIGHT_FROM;
  if (!from) throw new Error('PLAYWRIGHT_FROM is not set');
  const index = join(dir, 'index.html');
  if (!existsSync(index)) throw new Error(`${index} does not exist`);

  const { chromium } = createRequire(resolve(from))('@playwright/test');
  const server = await serve(root);
  let browser;
  const taken = [];
  try {
    browser = await chromium.launch();
    for (const colorScheme of SCHEMES) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
        colorScheme,
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/${channel}/index.html`);
      await page.waitForFunction(
        () =>
          document.querySelector('main') !== null && document.querySelector('[aria-busy="true"]') === null,
        undefined,
        { timeout: READY_TIMEOUT_MS },
      );
      await page.waitForTimeout(SETTLE_MS);
      // A page that shows an alert is not the report: the viewer's load-failure screen and a dashboard that could not read
      // its variables' values both render a <main> holding one and no busy marker, so they pass the wait above.
      const alert = await page.evaluate(() => {
        const el = document.querySelector('main [role="alert"]');
        return el === null ? null : (el.textContent ?? '').trim().split('\n')[0];
      });
      if (alert !== null) throw new Error(`the page shows an alert: ${alert}`);
      const tmp = join(dir, `preview-${colorScheme}.png.tmp`);
      await page.screenshot({ path: tmp, type: 'png' });
      taken.push([tmp, join(dir, `preview-${colorScheme}.png`)]);
      await context.close();
    }
  } catch (error) {
    for (const [tmp] of taken) rmSync(tmp, { force: true });
    throw error;
  } finally {
    await browser?.close();
    await server.close();
  }
  for (const [tmp, final] of taken) renameSync(tmp, final);
}

try {
  await main();
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
  process.stdout.write(`::warning::otel-html preview: ${message}\n`);
}
