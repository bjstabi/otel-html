import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { reviveDataJson, unwrapDataFile } from '../src/format/data-file.js';
import { isV4, parseAnyManifest } from '../src/format/manifest.js';
import { MANIFEST_KEY } from '../src/format/paths.js';
import { PORT_ENV, reportDir } from './fixture.js';
import { REQUESTS_PATH, type RequestRecord } from './static-server.js';
import { expect, HTTP, test } from './test.js';
import { runWorkerSql } from './worker-sql.js';

// Query-scaling plan, Task 8, Step 5: DuckDB-WASM accepts a file swapped from a URL registration to a buffer after it
// was opened (what `swapToBuffer` does), and answers the same. Nothing in the page calls `prepare` yet (Task 9 wires it
// into the data layer), so the swap is sent to the worker as the two messages `swapToBuffer` produces.

async function manifestPaths(): Promise<string[]> {
  const text = readFileSync(new URL('data/manifest.js', reportDir('main', 'http')), 'utf8');
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(manifest)) throw new Error('not a v4 manifest');
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

    const replies = await swapInWorker(page, baseURL ?? '', paths);
    expect(
      replies.every((r) => r === 'OK/OK'),
      replies.join(' '),
    ).toBe(true);

    const port = process.env[PORT_ENV];
    const seen = async (): Promise<RequestRecord[]> =>
      (await (await fetch(`http://127.0.0.1:${port}${REQUESTS_PATH}`)).json()) as RequestRecord[];
    const mark = (await seen()).length;
    const after = { traces: await countOf(page, 'traces'), spans: await countOf(page, 'spans') };
    expect(after).toEqual(before);
    const partitionRequests = (await seen()).slice(mark).filter((r) => r.path.includes('/data/partitions/'));
    process.stdout.write(
      `SMALL-FILES swapped ${paths.length} files; counts ${JSON.stringify(before)} -> ${JSON.stringify(after)}; partition requests after the swap: ${partitionRequests.length}\n`,
    );
    expect(partitionRequests).toEqual([]);
  },
);
