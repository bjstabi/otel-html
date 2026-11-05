import { describe, expect, test } from 'vitest';
import { contextEnv, contextJson, resolveJob } from '../../../src/cli/ci/context.js';
import type { ApiJob, ApiRun } from '../../../src/cli/ci/github-api.js';
import { runKey } from '../../../src/cli/ci/ids.js';
import { approximateJobIds, jobIdFor, parseJobContext } from '../../../src/cli/ci/publish.js';
import { workflowTraceRequest } from '../../../src/cli/ci/workflow-trace.js';

const j = (id: number, name = `job${id}`, runner: string | null = 'gh-1'): ApiJob =>
  ({ id, name, runner_name: runner }) as ApiJob;
const fallback = (hint: string, runner: string) =>
  ({ jobId: `name:${hint}@${runner}`, approximate: true, jobName: hint, runner }) as const;

describe('parseJobContext', () => {
  test('numeric and name ids', () => {
    expect(parseJobContext('{"jobId":5,"approximate":false}')).toEqual({ jobId: 5, approximate: false });
    expect(parseJobContext('{"jobId":"name:x","approximate":true}')).toEqual({
      jobId: 'name:x',
      approximate: true,
    });
  });
  test('keeps jobName and runner of a fallback context', () => {
    expect(parseJobContext('{"jobId":"name:e@r","approximate":true,"jobName":"e","runner":"r"}')).toEqual({
      jobId: 'name:e@r',
      approximate: true,
      jobName: 'e',
      runner: 'r',
    });
    expect(parseJobContext('{"jobId":"name:e","approximate":true,"jobName":3}')).toEqual({
      jobId: 'name:e',
      approximate: true,
    });
  });
  test.each([undefined, '', 'nope', '[]', '{"jobId":5}', '{"jobId":null,"approximate":false}'])(
    'tolerates %j',
    (t) => expect(parseJobContext(t)).toBeUndefined(),
  );
});

describe('approximateJobIds', () => {
  test('a matrix leg takes its context id verbatim', () => {
    const ids = approximateJobIds([j(7, 'e2e (chromium)')], [fallback('e2e', 'gh-1')]);
    expect(ids.get(7)).toBe('name:e2e@gh-1');
  });
  test('two legs with one hint are told apart by runner', () => {
    const ids = approximateJobIds(
      [j(7, 'e2e (chromium)', 'gh-1'), j(8, 'e2e (webkit)', 'gh-2')],
      [fallback('e2e', 'gh-2'), fallback('e2e', 'gh-1')],
    );
    expect([ids.get(7), ids.get(8)]).toEqual(['name:e2e@gh-1', 'name:e2e@gh-2']);
  });
  test('a renamed job (name: Lint, hint lint) matches', () => {
    expect(approximateJobIds([j(3, 'Lint')], [fallback('lint', 'gh-1')]).get(3)).toBe('name:lint@gh-1');
  });
  test("a leg whose own context is missing does not take its sibling's id", () => {
    const ids = approximateJobIds(
      [j(7, 'e2e (chromium)', 'gh-1'), j(8, 'e2e (webkit)', 'gh-2')],
      [fallback('e2e', 'gh-1')],
    );
    expect([ids.get(7), ids.get(8)]).toEqual(['name:e2e@gh-1', 'name:e2e (webkit)']);
  });
  test('a job with no context, or only an old one, keeps name:<display>', () => {
    expect(approximateJobIds([j(4, 'build')], []).get(4)).toBe('name:build');
    expect(approximateJobIds([j(4, 'build')], [{ jobId: 'name:build', approximate: true }]).get(4)).toBe(
      'name:build',
    );
  });
  test('an exact claim leaves the job out of the map', () => {
    expect(approximateJobIds([j(1), j(2)], [{ jobId: 1, approximate: false }]).has(1)).toBe(false);
  });
  test('jobIdFor reads the map', () => {
    expect(jobIdFor(j(2, 'lint'), new Map([[2, 'name:lint@gh-1']]))).toBe('name:lint@gh-1');
    expect(jobIdFor(j(2, 'lint'), new Map())).toBe(2);
  });
});

test('a matrix leg whose lookup failed parents its spans under the publisher job span', () => {
  const resolved = resolveJob([], 'gh-1', 'e2e');
  const key = runKey({ repository: 'o/r', runId: 42, runAttempt: 1 });
  const parent = contextEnv({
    repository: 'o/r',
    runId: 42,
    runAttempt: 1,
    workflow: 'ci',
    runUrl: 'https://github.com/o/r/actions/runs/42',
    ref: 'main',
    sha: 'abc',
    serverUrl: 'https://github.com',
    jobName: 'e2e',
    jobId: resolved.jobId,
  }).TRACEPARENT.split('-')[2];
  const run = {
    id: 42,
    run_attempt: 1,
    name: 'ci',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-01-01T00:00:00Z',
    run_started_at: '2026-01-01T00:00:05Z',
    updated_at: '2026-01-01T00:10:00Z',
    html_url: 'https://github.com/o/r/actions/runs/42',
    head_branch: 'main',
    head_sha: 'abc',
    repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
    head_repository: { full_name: 'o/r' },
  } as ApiRun;
  const leg = {
    ...j(7, 'e2e (chromium)', 'gh-1'),
    steps: [],
    started_at: null,
    completed_at: null,
    created_at: '2026-01-01T00:00:00Z',
  } as ApiJob;
  const ids = approximateJobIds([leg], [parseJobContext(contextJson(resolved))]);
  const req = workflowTraceRequest(key, run, [leg], ids) as {
    resourceSpans: { scopeSpans: { spans: { name: string; spanId: string }[] }[] }[];
  };
  const spans = req.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
  expect(spans.find((s) => s.name === 'e2e (chromium)')?.spanId).toBe(parent);
});
