import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createReportWith, resolveDeps } from '../../../src/api/report.js';
import { finishedView } from '../../../src/cli/ci/finished-view.js';
import type { ApiJob, ApiRun } from '../../../src/cli/ci/github-api.js';
import { runKey } from '../../../src/cli/ci/ids.js';
import { runReport } from '../../../src/cli/ci/report-main.js';
import { workflowTraceRequest } from '../../../src/cli/ci/workflow-trace.js';
import type { CliIo } from '../../../src/cli/io.js';
import type { WriterDeps } from '../../../src/writer/session.js';
import { fakeViewerAssets } from '../../../test-support/writer-deps.js';

const run = (over: Partial<ApiRun> = {}): ApiRun => ({
  id: 42,
  run_attempt: 1,
  name: 'ci',
  event: 'push',
  display_title: 't',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-01-01T00:00:00Z',
  run_started_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:02:00Z',
  html_url: 'https://github.com/o/r/actions/runs/42',
  path: '.github/workflows/ci.yml',
  actor: { type: 'User' },
  head_branch: 'main',
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
  html_url: null,
  steps: [],
  ...over,
});
const running = (id: number, name: string): ApiJob =>
  job(id, name, null, { status: 'in_progress', completed_at: null });

describe('finishedView', () => {
  const inProgress = run({ status: 'in_progress', conclusion: null, updated_at: '2026-01-01T00:00:05Z' });
  const view = (jobs: ApiJob[], r: ApiRun = inProgress) => finishedView(r, jobs, 'site / ');

  test.each([
    ['success and skipped', ['success', 'skipped'], 'success'],
    ['failure and skipped', ['failure', 'skipped'], 'failure'],
    ['timed out', ['success', 'timed_out'], 'failure'],
    ['failure over cancelled', ['cancelled', 'failure'], 'failure'],
    ['success and cancelled', ['success', 'cancelled'], 'cancelled'],
  ])('%s gives %s', (_name, conclusions, expected) => {
    const jobs = conclusions.map((c, i) => job(i + 1, `j${i}`, c));
    const v = view(jobs);
    expect(v.run.status).toBe('completed');
    expect(v.run.conclusion).toBe(expected);
  });

  test('drops the excluded jobs and takes updated_at from the latest remaining completed_at', () => {
    const jobs = [
      job(1, 'build', 'success'),
      job(2, 'test', 'success'),
      running(8, 'site / report'),
      { ...job(9, 'site / deploy', null), status: 'queued', completed_at: null },
    ];
    const v = view(jobs);
    expect(v.jobs.map((j) => j.name)).toEqual(['build', 'test']);
    expect(v.run.updated_at).toBe('2026-01-01T00:00:12Z');
  });

  test('the workflow-trace spans equal those of the completed run: result, end time, jobs, no provisional spans', () => {
    const done = [job(1, 'build', 'failure'), job(2, 'lint', 'skipped')];
    const inRun = [
      ...done,
      running(8, 'site / report'),
      { ...job(9, 'site / deploy', null), status: 'queued' },
    ];
    const completed = run({ conclusion: 'failure', updated_at: '2026-01-01T00:00:12Z' });
    const key = runKey({ repository: 'o/r', runId: 42, runAttempt: 1 });
    const v = view(inRun);
    const spans = workflowTraceRequest(key, v.run, v.jobs, new Map());
    expect(spans).toEqual(workflowTraceRequest(key, completed, done, new Map()));
    const text = JSON.stringify(spans);
    expect(text).toContain('failure');
    expect(text).not.toContain('otel_html.ci.provisional');
    expect(text).not.toContain('site / ');
  });

  test('a completed run passes through unchanged', () => {
    const done = run();
    const jobs = [job(1, 'build', 'success'), job(2, 'site / report', 'success')];
    const v = finishedView(done, jobs, 'site / ');
    expect(v.run).toBe(done);
    expect(v.jobs.map((j) => j.name)).toEqual(['build']);
  });

  test('an empty prefix excludes nothing', () => {
    const jobs = [job(1, 'build', 'success')];
    expect(finishedView(inProgress, jobs, '').jobs).toEqual(jobs);
  });

  test('an empty prefix reports an unfinished run as it is', () => {
    const jobs = [job(1, 'build', 'success'), running(2, 'test')];
    const v = finishedView(inProgress, jobs, '');
    expect(v.run).toBe(inProgress);
    expect(v.run.status).toBe('in_progress');
  });
});

describe('runReport from inside the run', () => {
  let dir: string;
  let out: string[];
  let deps: WriterDeps;
  const io = (): CliIo =>
    ({
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => out.push(s),
      env: {},
      cwd: dir,
    }) as unknown as CliIo;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'report-main-'));
    out = [];
    deps = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function artifacts(): Promise<string> {
    const root = join(dir, 'artifacts');
    const art = join(root, 'otel-html-build');
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, 'context.json'), JSON.stringify({ jobId: 1, approximate: false }));
    const r = await createReportWith({ out: join(art, 'report') }, deps);
    await r.addLogs({
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                { timeUnixNano: '1767225615000000000', severityNumber: 9, body: { stringValue: 'x' } },
              ],
            },
          ],
        },
      ],
    });
    await r.close();
    return root;
  }

  const apiOf = (r: ApiRun, jobs: ApiJob[], logged: string[]) => async (url: string) => {
    if (url.includes('/logs')) {
      logged.push(url);
      return new Response('2026-01-01T00:00:11.0000000Z hello\n');
    }
    if (url.includes('/jobs')) return Response.json({ jobs });
    return Response.json(r);
  };

  test('an in-progress run without its site jobs reports what the completed run does', async () => {
    const root = await artifacts();
    const done = [job(1, 'build', 'success'), job(2, 'lint', 'skipped')];
    const afterwards = run({ updated_at: '2026-01-01T00:00:12Z' });
    const logsA: string[] = [];
    const opts = { runId: 42, repository: 'o/r', artifacts: root, token: 't', stepSummary: false };
    await runReport({ ...opts, out: join(dir, 'a') }, io(), deps, apiOf(afterwards, done, logsA));
    const post = out.join('').replaceAll(join(dir, 'a'), '<out>');
    out = [];

    const during = run({ status: 'in_progress', conclusion: null, updated_at: '2026-01-01T00:00:05Z' });
    const inRun = [
      ...done,
      running(8, 'site / report'),
      { ...job(9, 'site / deploy', null), status: 'queued' },
    ];
    const logsB: string[] = [];
    await runReport(
      { ...opts, out: join(dir, 'b'), excludeJobs: 'site / ' },
      io(),
      deps,
      apiOf(during, inRun, logsB),
    );
    expect(out.join('').replaceAll(join(dir, 'b'), '<out>')).toBe(post);
    expect(post).toContain('merged 2 reports');
    expect(logsB).toEqual(logsA);
    expect(logsB.some((u) => u.includes('/jobs/8/') || u.includes('/jobs/9/'))).toBe(false);
  });
});
