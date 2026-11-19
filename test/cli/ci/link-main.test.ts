import { describe, expect, test } from 'vitest';
import type { ApiJob, ApiRun } from '../../../src/cli/ci/github-api.js';
import { runLink } from '../../../src/cli/ci/link-main.js';
import type { CliIo } from '../../../src/cli/io.js';
import { parseDashboardParam } from '../../../src/viewer/state/dashboard-state.js';

const run = (over: Partial<ApiRun> = {}): ApiRun => ({
  id: 42,
  run_attempt: 1,
  name: 'ci',
  event: 'pull_request',
  display_title: 't',
  status: 'completed',
  conclusion: 'failure',
  created_at: '2026-01-01T00:00:00Z',
  run_started_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:02:00Z',
  html_url: 'https://github.com/o/r/actions/runs/42',
  path: '.github/workflows/ci.yml',
  actor: { type: 'User' },
  head_branch: 'feat',
  head_sha: 'abc',
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
  head_repository: { full_name: 'o/r' },
  ...over,
});
const job = (id: number, name: string, conclusion: string | null, over: Partial<ApiJob> = {}): ApiJob => ({
  id,
  name,
  status: 'completed',
  runner_name: 'r1',
  labels: [],
  conclusion,
  created_at: '2026-01-01T00:00:00Z',
  started_at: '2026-01-01T00:00:10Z',
  completed_at: `2026-01-01T00:00:${10 + id}Z`,
  html_url: `https://github.com/o/r/actions/runs/42/job/${id}`,
  steps: [],
  ...over,
});

type Sent = { method: string; url: string; body: unknown };

async function linked(
  r: ApiRun,
  jobs: ApiJob[],
  excludeJobs?: string,
  index: unknown = { version: 1, channels: [] },
  url = 'https://x/pr/5/runs/42/',
): Promise<Sent[]> {
  const sent: Sent[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, url, body: JSON.parse(String(init?.body)) });
      return Response.json({});
    }
    if (url.endsWith('/index.json')) return Response.json(index);
    if (url.includes('/jobs')) return Response.json({ jobs });
    if (url.includes('/pulls'))
      return Response.json([
        {
          number: 5,
          title: 't',
          state: 'open',
          head: { sha: 'abc', ref: 'feat', repo: { full_name: 'o/r' } },
        },
      ]);
    if (url.includes('/comments')) return Response.json([]);
    if (url.includes('/actions/runs/')) return Response.json(r);
    return Response.json({ default_branch: 'main' });
  };
  const io = { stdout: () => undefined, stderr: () => undefined, env: {}, cwd: '.' } as unknown as CliIo;
  await runLink(
    {
      runId: 42,
      repository: 'o/r',
      url,
      indexUrl: 'https://x/index.json',
      comment: true,
      check: true,
      ...(excludeJobs === undefined ? {} : { excludeJobs }),
    },
    io,
    fetchFn as unknown as typeof fetch,
  );
  return sent;
}

describe('runLink from inside the run', () => {
  test('an in-progress run with its site jobs links what the completed run without them does', async () => {
    const done = [job(1, 'build', 'failure'), job(2, 'lint', 'skipped')];
    const post = await linked(run({ updated_at: '2026-01-01T00:00:12Z' }), done);
    const during = run({ status: 'in_progress', conclusion: null, updated_at: '2026-01-01T00:00:05Z' });
    const inRun = [
      ...done,
      job(8, 'site / report', null, { status: 'in_progress', completed_at: null }),
      job(9, 'site / deploy', null, { status: 'queued', completed_at: null, started_at: null }),
    ];
    const inside = await linked(during, inRun, 'site / ');
    expect(post.map((s) => s.method)).toContain('POST');
    expect(inside).toEqual(post);
    const comment = JSON.stringify(inside);
    expect(comment).not.toContain('site / ');
  });

  test('without the prefix the unfinished run is linked as the API has it', async () => {
    const during = run({ status: 'in_progress', conclusion: null });
    const inRun = [job(1, 'build', 'success'), job(8, 'site / report', null, { status: 'in_progress' })];
    expect(JSON.stringify(await linked(during, inRun))).toContain('site / report');
  });

  test('the all-runs link reaches the one report and its window holds the run the comment is about', async () => {
    const old = {
      runId: 7,
      attempt: 1,
      conclusion: 'success',
      headSha: 'zzz',
      headBranch: 'feat',
      startedAt: '2025-12-01T00:00:00Z',
      completedAt: '2025-12-01T00:05:00Z',
      runUrl: 'u',
      reportPath: 'pr/5/runs/7',
    };
    const index = {
      version: 1,
      channels: { 'pr/5': { kind: 'pr', title: '#5 t', headBranch: 'feat', runs: [old] } },
    };
    const done = [job(1, 'build', 'failure')];
    const post = await linked(
      run({ updated_at: '2026-01-01T00:02:00Z' }),
      done,
      undefined,
      index,
      'https://x/branch/main/#/dashboards/ci?t=1~2',
    );
    const body = JSON.stringify(post);
    const m = /All runs on pull request #5: (\S+?)(?:\\n|")/.exec(body);
    const link = m?.[1] ?? '';
    expect(link.startsWith('https://x/branch/main/#/dashboards/ci?')).toBe(true);
    const q = new URLSearchParams(link.slice(link.indexOf('?') + 1));
    const [start, end] = (q.get('t') ?? '').split('~').map((x) => BigInt(x));
    const ns = (iso: string): bigint => BigInt(Date.parse(iso)) * 1_000_000n;
    expect(start).toBeLessThanOrEqual(ns('2025-12-01T00:00:00Z'));
    expect(end).toBeGreaterThanOrEqual(ns('2026-01-01T00:02:00Z'));
    expect(parseDashboardParam(q.get('d') ?? '')).toMatchObject({
      ok: true,
      state: { vars: { 'vcs.ref.head.name': 'feat' } },
    });
  });
});
