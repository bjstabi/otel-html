import { describe, expect, test } from 'vitest';
import { runDispatch } from '../../../src/cli/ci/dispatch.js';
import type { CliIo } from '../../../src/cli/io.js';

type Call = { url: string; method: string; body?: unknown };

function setup(over: {
  actor?: string;
  headRepo?: string;
  postStatus?: number;
  env?: Record<string, string>;
  /** The answers of successive run listings; the last repeats. */
  listings?: {
    id: number;
    html_url: string;
    status: string;
    conclusion: string | null;
    created_at: string;
  }[][];
}) {
  const lines: string[] = [];
  const calls: Call[] = [];
  let listed = 0;
  const io = {
    stdout: (s: string) => lines.push(s),
    stderr: (s: string) => lines.push(s),
    env: { GITHUB_TOKEN: 't', ...over.env },
    cwd: '/',
  } as unknown as CliIo;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
    if (method === 'POST') return new Response(null, { status: over.postStatus ?? 204 });
    if (/\/actions\/runs\/42$/.test(url))
      return Response.json({
        id: 42,
        actor: { type: over.actor ?? 'User' },
        repository: { full_name: 'o/r' },
        head_repository: { full_name: over.headRepo ?? 'o/r' },
      });
    if (/\/workflows\/pages-deploy\.yml\/runs\?/.test(url)) {
      const all = over.listings ?? [[]];
      const page = all[Math.min(listed++, all.length - 1)] ?? [];
      return Response.json({ workflow_runs: page });
    }
    return Response.json({ default_branch: 'trunk' });
  };
  return { io, lines, calls, fetchFn };
}
const sleeps: number[] = [];
const noWait = async (ms: number): Promise<void> => {
  sleeps.push(ms);
};
const NOW = Date.parse('2026-11-10T10:00:00Z');
const run = (over: { id?: number; status?: string; conclusion?: string | null; created?: string }) => ({
  id: over.id ?? 7,
  html_url: `https://github.com/o/r/actions/runs/${over.id ?? 7}`,
  status: over.status ?? 'completed',
  conclusion: over.conclusion === undefined ? 'startup_failure' : over.conclusion,
  created_at: over.created ?? '2026-11-10T10:00:01Z',
});
const opts = { workflow: 'pages-deploy.yml', repository: 'o/r', runId: 42 };

describe('runDispatch', () => {
  test('a same-repository run by a user dispatches the workflow on the default branch', async () => {
    const s = setup({});
    await runDispatch(opts, s.io, s.fetchFn, { sleep: noWait, now: () => NOW });
    const post = s.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('https://api.github.com/repos/o/r/actions/workflows/pages-deploy.yml/dispatches');
    expect(post?.body).toEqual({ ref: 'trunk' });
  });

  test('a bot actor dispatches nothing and says so in one line', async () => {
    const s = setup({ actor: 'Bot' });
    await runDispatch(opts, s.io, s.fetchFn);
    expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(s.lines).toHaveLength(1);
  });

  test('a fork run dispatches nothing', async () => {
    const s = setup({ headRepo: 'fork/r' });
    await runDispatch(opts, s.io, s.fetchFn);
    expect(s.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('a 403 is one line and resolves', async () => {
    const s = setup({ postStatus: 403 });
    await expect(runDispatch(opts, s.io, s.fetchFn)).resolves.toBeUndefined();
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toContain('403');
  });

  test('a network failure is one line and resolves', async () => {
    const s = setup({});
    await expect(
      runDispatch(opts, s.io, async () => {
        throw new Error('down');
      }),
    ).resolves.toBeUndefined();
    expect(s.lines).toHaveLength(1);
  });

  describe('after a 204', () => {
    const go = (s: ReturnType<typeof setup>) =>
      runDispatch(opts, s.io, s.fetchFn, { sleep: noWait, now: () => NOW });

    test('lists the deployer runs created since just before the dispatch', async () => {
      const s = setup({ listings: [[run({})]] });
      await go(s);
      const list = s.calls.find(
        (c) => c.method === 'GET' && c.url.includes('/workflows/pages-deploy.yml/runs?'),
      );
      const q = new URL(list?.url ?? '').searchParams;
      expect(q.get('event')).toBe('workflow_dispatch');
      expect(q.get('created')).toBe('>=2026-11-10T09:59:55.000Z');
    });

    test('a startup_failure run is one warning naming its URL and the README paragraph', async () => {
      sleeps.length = 0;
      const s = setup({ listings: [[run({})]] });
      await go(s);
      const warnings = s.lines.filter((l) => l.startsWith('::warning::'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('https://github.com/o/r/actions/runs/7');
      expect(warnings[0]).toContain('dispatch token');
      expect(warnings[0]).toContain('README');
    });

    test('picks the newest run when several are listed', async () => {
      const s = setup({
        listings: [
          [
            run({ id: 1, conclusion: 'success', created: '2026-11-10T10:00:00Z' }),
            run({ id: 2, created: '2026-11-10T10:00:03Z' }),
          ],
        ],
      });
      await go(s);
      expect(s.lines.join('\n')).toContain('/runs/2');
    });

    test('a run in progress ends the wait without a warning', async () => {
      const s = setup({ listings: [[run({ status: 'in_progress', conclusion: null })]] });
      await go(s);
      expect(s.lines.some((l) => l.startsWith('::warning::'))).toBe(false);
      expect(s.calls.filter((c) => c.url.includes('/runs?'))).toHaveLength(1);
    });

    test('polls until the run appears, then reads its conclusion', async () => {
      const s = setup({ listings: [[], [run({ status: 'queued', conclusion: null })], [run({})]] });
      await go(s);
      expect(s.calls.filter((c) => c.url.includes('/runs?'))).toHaveLength(3);
      expect(s.lines.filter((l) => l.startsWith('::warning::'))).toHaveLength(1);
    });

    test('finding nothing in time stops after a bounded number of tries and says nothing more', async () => {
      sleeps.length = 0;
      const s = setup({ listings: [[]] });
      await go(s);
      const tries = s.calls.filter((c) => c.url.includes('/runs?')).length;
      expect(tries).toBeLessThanOrEqual(6);
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20_000);
      expect(s.lines).toHaveLength(1);
    });

    test('a failing listing is silent', async () => {
      const s = setup({});
      const base = s.fetchFn;
      await runDispatch(
        opts,
        s.io,
        async (url, init) => {
          if (url.includes('/runs?')) return new Response(null, { status: 500 });
          return base(url, init);
        },
        { sleep: noWait, now: () => NOW },
      );
      expect(s.lines).toHaveLength(1);
    });
  });
});
