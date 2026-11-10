import { describe, expect, test } from 'vitest';
import { runDispatch } from '../../../src/cli/ci/dispatch.js';
import type { CliIo } from '../../../src/cli/io.js';

type Call = { url: string; method: string; body?: unknown };

function setup(over: {
  actor?: string;
  headRepo?: string;
  postStatus?: number;
  env?: Record<string, string>;
}) {
  const lines: string[] = [];
  const calls: Call[] = [];
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
    return Response.json({ default_branch: 'trunk' });
  };
  return { io, lines, calls, fetchFn };
}
const opts = { workflow: 'pages-deploy.yml', repository: 'o/r', runId: 42 };

describe('runDispatch', () => {
  test('a same-repository run by a user dispatches the workflow on the default branch', async () => {
    const s = setup({});
    await runDispatch(opts, s.io, s.fetchFn);
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
});
