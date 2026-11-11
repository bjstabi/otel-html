import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createReportWith, resolveDeps } from '../../../src/api/report.js';
import type { uploadArtifact } from '../../../src/cli/ci/artifact-client.js';
import { readLedger } from '../../../src/cli/ci/ledger.js';
import { type PusherDeps, type PusherOptions, runPusher, tick } from '../../../src/cli/ci/pusher.js';
import { readZip } from '../../../src/cli/ci/zip.js';
import type { WriterDeps } from '../../../src/writer/session.js';
import { fakeViewerAssets } from '../../../test-support/writer-deps.js';

let dir: string;
let deps: WriterDeps;
let log: string[];
let uploads: { name: string; files: string[] }[];
let failNext: Error | undefined;
let sleeps: number[];
let onSleep: (() => Promise<void> | void) | undefined;

const ENV = {
  ACTIONS_RUNTIME_TOKEN: 'tok',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_REPOSITORY: 'o/r',
};

const fakeUpload: typeof uploadArtifact = async (o) => {
  if (failNext !== undefined) {
    const e = failNext;
    failNext = undefined;
    throw e;
  }
  uploads.push({ name: o.name, files: [...readZip(o.zip, 1 << 30).keys()] });
  return { id: uploads.length, size: o.zip.length };
};

const opts = (over: Partial<PusherOptions> = {}): PusherOptions => ({
  report: join(dir, '.otel-html', 'report'),
  publishDir: join(dir, '.otel-html', 'publish'),
  everyMs: 60_000,
  env: ENV,
  deployerWorkflow: 'pages-deploy.yml',
  ...over,
});
const pdeps = (): PusherDeps => ({
  fs: deps.fs,
  clock: deps.clock,
  sleep: async (ms) => {
    sleeps.push(ms);
    await onSleep?.();
  },
  upload: fakeUpload,
  fetchFn: (async () => new Response('no', { status: 500 })) as typeof fetch,
  log: (l) => log.push(l),
  deps,
});

const logRequest = (n: number): object => ({
  resourceLogs: [
    {
      resource: { attributes: [] },
      scopeLogs: [
        {
          scope: {},
          logRecords: [
            { timeUnixNano: `170000000000000000${n}`, body: { stringValue: `m${n}` }, severityNumber: 9 },
          ],
        },
      ],
    },
  ],
});

type Report = Awaited<ReturnType<typeof createReportWith>>;
async function openReport(): Promise<Report> {
  const root = join(dir, '.otel-html');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'context.json'), JSON.stringify({ jobId: 777, approximate: false }));
  return createReportWith({ out: join(root, 'report'), format: 'local', assetsBase: 'assets/' }, deps);
}
async function flush(r: Report, n: number): Promise<void> {
  await r.addLogs(logRequest(n));
  await r.flush();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pusher-'));
  log = [];
  uploads = [];
  sleeps = [];
  failNext = undefined;
  onSleep = undefined;
  deps = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tick', () => {
  test('no manifest: nothing to do', async () => {
    mkdirSync(join(dir, '.otel-html'), { recursive: true });
    const r = await tick(opts(), pdeps(), null);
    expect(r).toEqual({ outcome: 'unchanged', listing: [] });
    expect(uploads).toEqual([]);
  });

  test('uploads new partitions once, then a flush, then a compaction', async () => {
    const o = opts();
    const r = await openReport();
    await flush(r, 1);
    const t1 = await tick(o, pdeps(), null);
    expect(t1.outcome).toBe('uploaded');
    expect(uploads.map((u) => u.name)).toEqual(['otel-html-update-push-777-1']);
    expect(uploads[0]?.files).toContain('update.json');
    expect(uploads[0]?.files).toContain('partitions/0/logs.parquet');
    let ledger = await readLedger(deps.fs, o.publishDir);
    expect(ledger.sequence).toBe(1);
    expect(ledger.shipped).toEqual(['flush:0']);
    expect(ledger.uploads.map((u) => u.name)).toEqual(['otel-html-update-push-777-1']);
    expect(readdirSync(o.publishDir).filter((n) => n.startsWith('tick-'))).toEqual([]);

    const same = await tick(o, pdeps(), t1.listing);
    expect(same.outcome).toBe('unchanged');
    expect(uploads).toHaveLength(1);

    await flush(r, 2);
    const t2 = await tick(o, pdeps(), same.listing);
    expect(t2.outcome).toBe('uploaded');
    expect(uploads[1]?.name).toBe('otel-html-update-push-777-2');
    expect(uploads[1]?.files).toContain('partitions/1/logs.parquet');
    expect(uploads[1]?.files).not.toContain('partitions/0/logs.parquet');

    await r.close();
    const t3 = await tick(o, pdeps(), t2.listing);
    expect(t3.listing).toHaveLength(1);
    expect(t3.listing[0]).toMatch(/^compact:/);
    expect(uploads[2]?.name).toBe('otel-html-update-push-777-3');
    ledger = await readLedger(deps.fs, o.publishDir);
    expect(ledger.sequence).toBe(3);
    expect(ledger.shipped).toHaveLength(3);
    expect(ledger.shipped).toContain(t3.listing[0]);
  });

  test('a failed upload is a retry on a fresh sequence', async () => {
    const o = opts();
    const r = await openReport();
    await flush(r, 1);
    failNext = new Error('boom 503');
    const t1 = await tick(o, pdeps(), null);
    expect(t1.outcome).toBe('retry');
    expect(log.join('\n')).toContain('upload failed, will retry: boom 503');
    let ledger = await readLedger(deps.fs, o.publishDir);
    expect(ledger.sequence).toBe(1);
    expect(ledger.shipped).toEqual([]);
    expect(existsSync(join(o.publishDir, 'tick-1'))).toBe(false);

    const calls: string[] = [];
    const d2 = pdeps();
    const json = (b: object): Response => new Response(JSON.stringify(b), { status: 200 });
    d2.fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if (init?.method === 'POST') return new Response(null, { status: 204 });
      if (String(url).endsWith('/actions/runs/42'))
        return json({
          id: 42,
          actor: { type: 'User' },
          repository: { full_name: 'o/r' },
          head_repository: { full_name: 'o/r' },
        });
      return json({ default_branch: 'main', workflow_runs: [] });
    }) as unknown as typeof fetch;
    const t2 = await tick(o, d2, t1.listing);
    expect(t2.outcome).toBe('uploaded');
    expect(calls.some((u) => u.startsWith('POST') && u.includes('/dispatches'))).toBe(true);
    expect(calls.some((u) => u.includes('/runs?'))).toBe(false);
    expect(uploads.map((u) => u.name)).toEqual(['otel-html-update-push-777-2']);
    ledger = await readLedger(deps.fs, o.publishDir);
    expect(ledger.shipped).toEqual(['flush:0']);
  });

  test('the dispatch carries OTEL_HTML_DISPATCH_TOKEN; its own calls keep GITHUB_TOKEN', async () => {
    const o = opts({ env: { ...ENV, GITHUB_TOKEN: 'job-token', OTEL_HTML_DISPATCH_TOKEN: 'app-token' } });
    const r = await openReport();
    await flush(r, 1);
    const auth: string[] = [];
    const d = pdeps();
    const json = (b: object): Response => new Response(JSON.stringify(b), { status: 200 });
    d.fetchFn = (async (url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      auth.push(
        `${init?.method ?? 'GET'} ${String(url).includes('/dispatches') ? 'dispatch' : 'other'} ${h.get('authorization')}`,
      );
      if (init?.method === 'POST') return new Response(null, { status: 204 });
      if (String(url).endsWith('/actions/runs/42'))
        return json({
          id: 42,
          actor: { type: 'User' },
          repository: { full_name: 'o/r' },
          head_repository: { full_name: 'o/r' },
        });
      return json({ default_branch: 'main', workflow_runs: [] });
    }) as unknown as typeof fetch;
    const t = await tick(o, d, null);
    expect(t.outcome).toBe('uploaded');
    expect(auth).toContain('POST dispatch Bearer app-token');
    // the pusher's own calls (before the dispatch command starts) keep the job token
    expect(auth[0]).toBe('GET other Bearer job-token');
  });

  test('a partition file gone before the copy is a retry', async () => {
    const o = opts();
    const r = await openReport();
    await flush(r, 1);
    const parts = join(o.report, 'data', 'partitions');
    for (const p of readdirSync(parts)) rmSync(join(parts, p), { recursive: true });
    const t = await tick(o, pdeps(), null);
    expect(t.outcome).toBe('retry');
    expect(uploads).toEqual([]);
    expect(log).toHaveLength(1);
  });

  test('no ACTIONS_RUNTIME_TOKEN: one log line per tick and a retry', async () => {
    const r = await openReport();
    await flush(r, 1);
    const o = opts({ env: { ...ENV, ACTIONS_RUNTIME_TOKEN: undefined } });
    expect((await tick(o, pdeps(), null)).outcome).toBe('retry');
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('ACTIONS_RUNTIME_TOKEN');
    expect((await tick(o, pdeps(), null)).outcome).toBe('retry');
    expect(log).toHaveLength(2);
    expect(uploads).toEqual([]);
  });
});

describe('runPusher', () => {
  test('ticks every period, stops on the stop file and removes the pid file', async () => {
    const o = opts();
    const r = await openReport();
    await flush(r, 1);
    const signals = { on: () => () => undefined };
    let ticks = 0;
    onSleep = (): void => {
      // The pid file exists while running.
      expect(existsSync(join(o.publishDir, 'pusher.pid'))).toBe(true);
      ticks++;
      if (ticks === 2) writeFileSync(join(o.publishDir, 'pusher.stop'), '');
    };
    await runPusher(o, pdeps(), signals);
    expect(existsSync(join(o.publishDir, 'pusher.pid'))).toBe(false);
    expect(uploads).toHaveLength(1);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(sleeps.every((ms) => ms <= 1000)).toBe(true);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);
  });

  test('a fake clock run respects everyMs between ticks', async () => {
    const o = opts({ everyMs: 3000 });
    const r = await openReport();
    await flush(r, 1);
    const stop = join(o.publishDir, 'pusher.stop');
    let total = 0;
    const d = pdeps();
    d.sleep = async (ms) => {
      total += ms;
      sleeps.push(ms);
      if (total >= 6000) writeFileSync(stop, '');
    };
    await runPusher(o, d, { on: () => () => undefined });
    expect(total).toBeGreaterThanOrEqual(6000);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(total);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(1000);
  });

  test('everyMs below one second is clamped, so the loop waits', async () => {
    const o = opts({ everyMs: 0 });
    mkdirSync(join(dir, '.otel-html'), { recursive: true });
    let n = 0;
    onSleep = (): void => {
      if (++n === 3) writeFileSync(join(o.publishDir, 'pusher.stop'), '');
    };
    await runPusher(o, pdeps(), { on: () => () => undefined });
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
    expect(sleeps.every((ms) => ms === 1000)).toBe(true);
  });

  test('an fs error writing the pid file is logged, not silent', async () => {
    const o = opts();
    const d = pdeps();
    d.fs = { ...deps.fs, writeTextAtomic: async () => Promise.reject(new Error('disk full')) } as typeof d.fs;
    await runPusher(o, d, { on: () => () => undefined });
    expect(log.join('\n')).toContain('disk full');
  });

  test('an fs error checking the stop file is logged once and does not end the loop', async () => {
    const o = opts();
    mkdirSync(join(dir, '.otel-html'), { recursive: true });
    const d = pdeps();
    let broken = true;
    d.fs = {
      ...deps.fs,
      exists: async (p: string) => {
        if (broken && p.endsWith('pusher.stop')) throw new Error('EIO');
        return deps.fs.exists(p);
      },
    } as typeof d.fs;
    let n = 0;
    onSleep = (): void => {
      if (++n === 3) {
        broken = false;
        writeFileSync(join(o.publishDir, 'pusher.stop'), '');
      }
    };
    await runPusher(o, d, { on: () => () => undefined });
    expect(log.filter((l) => l.includes('EIO'))).toHaveLength(1);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  test('SIGTERM ends the loop', async () => {
    const o = opts();
    mkdirSync(join(dir, '.otel-html'), { recursive: true });
    let fire: (s: 'SIGTERM') => void = () => undefined;
    const signals = {
      on: (fn: (s: 'SIGINT' | 'SIGTERM') => void) => {
        fire = fn;
        return () => undefined;
      },
    };
    onSleep = (): void => fire('SIGTERM');
    await runPusher(o, pdeps(), signals);
    expect(existsSync(join(o.publishDir, 'pusher.pid'))).toBe(false);
  });
});
