import { describe, expect, test } from 'vitest';
import type { ApiJob, ApiRun } from '../../../src/cli/ci/github-api.js';
import { runLink } from '../../../src/cli/ci/link-main.js';
import type { CliIo } from '../../../src/cli/io.js';

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

async function linked(r: ApiRun, jobs: ApiJob[], excludeJobs?: string): Promise<Sent[]> {
  const sent: Sent[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, url, body: JSON.parse(String(init?.body)) });
      return Response.json({});
    }
    if (url.endsWith('/index.json')) return Response.json({ version: 1, channels: [] });
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
      url: 'https://x/pr/5/runs/42/',
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
});
