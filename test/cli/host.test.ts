import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { tableFromIPC } from 'apache-arrow';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CliIo, StopSignal } from '../../src/cli/io.js';
import { runCli } from '../../src/cli/program.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { buildFormat4Report, spansOnlyRequest } from '../../test-support/format4-fixture.js';
import { writeReportDir } from '../../test-support/report-dir.js';
import { createTestWriter } from '../../test-support/writer-deps.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

interface Harness {
  stdout: string;
  stderr: string;
  fire(signal?: StopSignal): void;
  subscribed(): boolean;
  result: Promise<number>;
}

function start(argv: readonly string[]): Harness {
  const handlers = new Set<(s: StopSignal) => void>();
  const h: Harness = {
    stdout: '',
    stderr: '',
    fire: (signal = 'SIGINT') => {
      for (const fn of [...handlers]) fn(signal);
    },
    subscribed: () => handlers.size > 0,
    result: Promise.resolve(0),
  };
  const io: CliIo = {
    stdout: (s) => {
      h.stdout += s;
    },
    stderr: (s) => {
      h.stderr += s;
    },
    env: {},
    cwd: '/work',
    signals: {
      on(fn) {
        handlers.add(fn);
        return () => handlers.delete(fn);
      },
    },
    spawn,
  };
  h.result = runCli(argv, io, { ...createTestWriter().deps, fs: createNodeFileSystem() });
  return h;
}

const open: Harness[] = [];
const servers: Server[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) {
    h.fire();
    h.fire();
    await h.result.catch(() => undefined);
  }
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const c of cleanups.splice(0)) await c();
});

async function reportDir(format: 'site' | 'local', assetsBase?: string): Promise<string> {
  const fixture = await buildFormat4Report([spansOnlyRequest(3), spansOnlyRequest(2)], {
    close: false,
    config: { writer: { format: 'site', ...(assetsBase === undefined ? {} : { assetsBase }) } },
  });
  fixture.manifest.engine.format = format;
  const report = await writeReportDir(fixture);
  cleanups.push(report.close);
  return report.dir;
}

async function line(h: Harness): Promise<string> {
  await vi.waitFor(() => expect(h.stdout).toContain('\n'), { timeout: 20_000 });
  return h.stdout.split('\n')[0] ?? '';
}

function baseOf(text: string): string {
  const m = /at (http:\/\/\S+\/) /.exec(text);
  if (m?.[1] === undefined) throw new Error(`no address in ${text}`);
  return m[1];
}

async function count(base: string, table = 'spans'): Promise<unknown> {
  const res = await fetch(`${base}query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'arrow', sql: `SELECT count(*) AS n FROM ${table}` }),
  });
  expect(res.status).toBe(200);
  const rows = tableFromIPC(new Uint8Array(await res.arrayBuffer())).toArray();
  return rows.map((r: { toJSON(): unknown }) => r.toJSON());
}

describe('host', () => {
  test.each([
    ['site', undefined],
    ['site', '../../assets/0.0.0/'],
    ['local', undefined],
  ] as const)('serves a %s report (assetsBase %s) until SIGINT', async (format, assetsBase) => {
    const dir = await reportDir(format, assetsBase);
    const h = start(['host', dir, '--port', '0']);
    open.push(h);
    const printed = await line(h);
    expect(printed).toMatch(
      new RegExp(
        `^serving ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} at http://127\\.0\\.0\\.1:\\d+/ \\(2 partitions, 0 MB of Parquet\\); press Ctrl-C to stop$`,
      ),
    );
    const base = baseOf(printed);
    const index = await fetch(`${base}index.html`);
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain('<meta name="otel-html-host" content="query">');
    expect(html).toContain('viewer.abc123.js');
    expect(await count(base)).toEqual([{ n: 5n }]);
    h.fire('SIGINT');
    expect(await h.result).toBe(0);
    await expect(fetch(base)).rejects.toThrow();
    expect(h.stderr).toBe('');
  });

  test('host serves the frozen format-4 report: one query over spans and one over points', async () => {
    const dir = join(import.meta.dirname, '../../fixtures/reports/format-4');
    const h = start(['host', dir, '--port', '0']);
    open.push(h);
    const base = baseOf(await line(h));
    expect(await count(base, 'spans')).toEqual([{ n: 1228n }]);
    expect(await count(base, 'points')).toEqual([{ n: 230n }]);
    h.fire('SIGINT');
    expect(await h.result).toBe(0);
    expect(h.stderr).toBe('');
  });

  test('SIGTERM stops it too', async () => {
    const h = start(['host', await reportDir('site'), '--port', '0']);
    open.push(h);
    await line(h);
    h.fire('SIGTERM');
    expect(await h.result).toBe(0);
  });

  const SLOW =
    'SELECT count(*) FROM range(300000000) r1, range(50) r2 WHERE (r1.range * r2.range) % 7919 = 1';

  test('SIGINT during a slow statement stops at once: the statement is answered 503 and the exit is 0', async () => {
    const h = start(['host', await reportDir('site'), '--port', '0', '--timeout', '20000']);
    open.push(h);
    const base = baseOf(await line(h));
    const slow = fetch(`${base}query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'arrow', sql: SLOW }),
    });
    const answered = slow.then(async (r) => ({ status: r.status, text: await r.text() }));
    answered.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1000));
    const t0 = performance.now();
    h.fire('SIGINT');
    expect(await h.result).toBe(0);
    const elapsed = performance.now() - t0;
    process.stdout.write(`perf: SIGINT to exit ${Math.round(elapsed)} ms\n`);
    expect(elapsed).toBeLessThan(4000);
    expect(await answered).toEqual({ status: 503, text: 'the host is closed' });
  });

  test('a second Ctrl-C while closing still ends the process cleanly', async () => {
    const h = start(['host', await reportDir('site'), '--port', '0', '--timeout', '20000']);
    open.push(h);
    await line(h);
    h.fire('SIGINT');
    h.fire('SIGINT');
    expect([0, 130]).toContain(await h.result);
  });

  test('a signal during start-up exits 0 without printing serving', async () => {
    const h = start(['host', await reportDir('site'), '--port', '0']);
    open.push(h);
    await vi.waitFor(() => expect(h.subscribed()).toBe(true));
    h.fire('SIGINT');
    expect(await h.result).toBe(0);
    expect(h.stdout).not.toContain('serving');
  });

  test('a second Ctrl-C during start-up exits 130, and nothing is left listening', async () => {
    const dir = await reportDir('site');
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise((r) => probe.close(r));
    const h = start(['host', dir, '--port', String(port)]);
    open.push(h);
    await vi.waitFor(() => expect(h.subscribed()).toBe(true));
    h.fire('SIGINT');
    await vi.waitFor(() => expect(h.subscribed()).toBe(true));
    h.fire('SIGINT');
    expect(await h.result).toBe(130);
    expect(h.stdout).not.toContain('serving');
    // What was still starting is closed when it settles.
    await new Promise((r) => setTimeout(r, 6000));
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  test('a missing folder is a usage error', async () => {
    const h = start(['host', '/nonexistent/otel-html-report', '--port', '0']);
    expect(await h.result).toBe(2);
    expect(h.stderr).toContain('no report found at /nonexistent/otel-html-report');
  });

  test('a format-3 report exits 2 with the merge hint', async () => {
    const dir = await reportDir('site');
    await rm(join(dir, 'data'), { recursive: true });
    await mkdir(join(dir, 'data'));
    await copyFile('fixtures/reports/format-3/data/manifest.js', join(dir, 'data/manifest.js'));
    const h = start(['host', dir, '--port', '0']);
    expect(await h.result).toBe(2);
    expect(h.stderr).toContain('otel-html merge');
  });

  test('a port in use exits 1 naming --port, and the process exits (the engine it started is stopped)', async () => {
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const address = blocker.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const h = start(['host', await reportDir('site'), '--port', String(port)]);
    expect(await h.result).toBe(1);
    expect(h.stderr).toContain('--port');
  });

  test.each([
    ['--timeout', 'x'],
    ['--timeout', '0'],
    ['--timeout', '86400001'],
    ['--max-result-bytes', '0'],
    ['--max-result-bytes', '1.5'],
    ['--max-result-bytes', '4294967297'],
    ['--port', '70000'],
  ])('%s %s exits 2', async (flag, value) => {
    const h = start(['host', await reportDir('site'), flag, value]);
    expect(await h.result).toBe(2);
    expect(h.stderr).toContain(flag);
  });
});
