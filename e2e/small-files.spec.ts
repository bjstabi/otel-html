import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { reviveDataJson, unwrapDataFile } from '../src/format/data-file.js';
import { isPartitioned, parseAnyManifest } from '../src/format/manifest.js';
import { MANIFEST_KEY } from '../src/format/paths.js';
import { SMALL_FILE_BYTES } from '../src/viewer/data/engine/small-files.js';
import { reportDir } from './fixture.js';
import type { RequestRecord } from './static-server.js';
import { expect, HTTP, test } from './test.js';
import { runWorkerSql } from './worker-sql.js';

// Query-scaling plan, Task 8, Step 5: DuckDB-WASM accepts a file swapped from a URL registration to a buffer after it
// was opened (what `swapToBuffer` does), and answers the same; the first test sends the worker the two messages
// `swapToBuffer` produces. Task 9: the data layer prepares the files each statement reads, so the second test opens
// the trace list and reads what the server saw.

async function manifestPaths(): Promise<string[]> {
  const text = readFileSync(new URL('data/manifest.js', reportDir('main', 'http')), 'utf8');
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isPartitioned(manifest)) throw new Error('not a v4 manifest');
  return manifest.partitions.flatMap((p) => Object.values(p.files).map((f) => f.path));
}

/** The number of rows of `table`, read from the message of an `error()` (runWorkerSql returns no rows). */
async function countOf(page: Page, table: string): Promise<string> {
  const reply = await runWorkerSql(page, `SELECT error('n=' || count(*)) FROM ${table}`);
  const m = /n=(\d+)/.exec(reply.message);
  if (m?.[1] === undefined) throw new Error(`${table}: ${reply.type} ${reply.message}`);
  return m[1];
}

/** Fetches each file whole in the worker and replaces its URL registration by a buffer: DROP_FILE, REGISTER_FILE_BUFFER. */
async function swapInWorker(page: Page, base: string, paths: readonly string[]): Promise<string[]> {
  const worker = page.workers().at(-1);
  if (worker === undefined) throw new Error('the page has no worker');
  return worker.evaluate(
    async ({ base, paths }) => {
      const g = globalThis as unknown as {
        postMessage: (m: unknown, t?: unknown) => void;
        onmessage: (e: { data: unknown }) => void;
      };
      const original = g.postMessage.bind(g);
      let resolveReply: (m: { type: string; data?: unknown }) => void = () => undefined;
      g.postMessage = (m, t) => {
        const reply = m as { requestId?: number };
        if (reply !== null && typeof reply === 'object' && (reply.requestId ?? 0) >= 800000) {
          resolveReply(m as never);
          return;
        }
        original(m, t);
      };
      let id = 800000;
      const send = (type: string, data: unknown) => {
        const reply = new Promise<{ type: string; data?: unknown }>((r) => {
          resolveReply = r as never;
        });
        g.onmessage({ data: { messageId: id++, type, data } });
        return reply;
      };
      const replies: string[] = [];
      try {
        for (const path of paths) {
          const bytes = new Uint8Array(await (await fetch(`${base}/${path}`)).arrayBuffer());
          const dropped = await send('DROP_FILE', path);
          const registered = await send('REGISTER_FILE_BUFFER', [path, bytes]);
          replies.push(`${dropped.type}/${registered.type}`);
        }
      } finally {
        g.postMessage = original;
      }
      return replies;
    },
    { base, paths: [...paths] },
  );
}

test(
  'a file swapped for a buffer after it was opened answers the same',
  HTTP,
  async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name.endsWith('-file'), 'a local report holds every file as a buffer already');
    const paths = await manifestPaths();
    await page.goto(`${baseURL}/index.html#/traces`);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('main').locator('output', { hasText: /\bspans\b/ })).toBeVisible();

    const before = { traces: await countOf(page, 'traces'), spans: await countOf(page, 'spans') };
    expect(Number(before.traces)).toBeGreaterThan(0);

    // what this page requested (the server's list is shared with the tests running in parallel)
    const pageRequests: RequestRecord[] = [];
    page.on('request', (request) => {
      pageRequests.push({
        path: new URL(request.url()).pathname,
        range: (request.headers() as { range?: string }).range ?? null,
        method: request.method(),
      });
    });
    const replies = await swapInWorker(page, baseURL ?? '', paths);
    expect(
      replies.every((r) => r === 'OK/OK'),
      replies.join(' '),
    ).toBe(true);

    const mark = pageRequests.length;
    const after = { traces: await countOf(page, 'traces'), spans: await countOf(page, 'spans') };
    expect(after).toEqual(before);
    const partitionRequests = pageRequests.slice(mark).filter((r) => r.path.includes('/data/partitions/'));
    process.stdout.write(
      `SMALL-FILES swapped ${paths.length} files; counts ${JSON.stringify(before)} -> ${JSON.stringify(after)}; partition requests after the swap: ${partitionRequests.length}\n`,
    );
    // The swap went around the data layer, which knows a file only once a statement made it prepare the file: a file no
    // statement had read yet is fetched whole by the first one that does (once), and nothing is read by range or twice.
    expect(
      partitionRequests.filter((r) => r.method !== 'GET' || r.range !== null),
      'a request after the swap that was not a whole GET',
    ).toEqual([]);
    const wholePaths = partitionRequests.map((r) => r.path);
    expect(wholePaths, 'a file requested again after the swap').toEqual([...new Set(wholePaths)]);
  },
);

test(
  'each small traces file is fetched whole at most once and never by range afterwards',
  HTTP,
  async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name.endsWith('-file'), 'a local report holds every file as a buffer already');
    const text = readFileSync(new URL('data/manifest.js', reportDir('main', 'http')), 'utf8');
    const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
    if (!isPartitioned(manifest)) throw new Error('not a v4 manifest');
    const small = manifest.partitions.flatMap((p) =>
      Object.values(p.files)
        .filter((f) => f.bytes <= SMALL_FILE_BYTES)
        .map((f) => f.path),
    );
    const traces = manifest.partitions.flatMap((p) => (p.files.traces ? [p.files.traces.path] : []));
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((t) => small.includes(t))).toBe(true);

    // what the page itself requested (the server's list also holds the other projects' requests)
    const seen: RequestRecord[] = [];
    page.on('request', (request) => {
      seen.push({
        path: new URL(request.url()).pathname,
        range: (request.headers() as { range?: string }).range ?? null,
        method: request.method(),
      });
    });
    await page.goto(`${baseURL}/index.html#/traces?mode=traces`);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('grid', { name: 'Results' }).getByRole('row')).not.toHaveCount(1);
    const whole = (r: RequestRecord): boolean => r.method === 'GET' && r.range === null;
    // the "never by range afterwards" check is vacuous if this browser does not report the worker's range reads
    // at all: the page's own opening reads (the view's footer reads) must show up as Range requests
    expect(
      seen.some((r) => r.range !== null && r.path.endsWith('.parquet')),
      'a Range request to a Parquet file was recorded',
    ).toBe(true);
    let fetched = 0;
    for (const path of small) {
      const mine = seen.filter((r) => r.path.endsWith(`/${path}`));
      const first = mine.findIndex(whole);
      expect(mine.filter(whole).length, `${path} fetched whole: ${JSON.stringify(mine)}`).toBeLessThanOrEqual(
        1,
      );
      if (first < 0) continue;
      fetched += 1;
      expect(mine.slice(first + 1), `${path} requested again after it was fetched whole`).toEqual([]);
    }
    for (const path of traces) {
      expect(
        seen.some((r) => r.path.endsWith(`/${path}`) && whole(r)),
        `${path} fetched whole`,
      ).toBe(true);
    }
    process.stdout.write(`SMALL-FILES ${fetched} of ${small.length} small files fetched whole, once each\n`);
  },
);
