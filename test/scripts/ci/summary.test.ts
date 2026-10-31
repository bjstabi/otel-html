import { describe, expect, test } from 'vitest';
import type { ApiJob, ApiRun } from '../../../scripts/ci/github-api.js';
import { formatDuration, summaryTable } from '../../../scripts/ci/summary.js';

const run: ApiRun = {
  id: 42,
  run_attempt: 1,
  name: 'ci',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  created_at: '2026-01-01T00:00:00Z',
  run_started_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:10:00Z',
  html_url: 'https://github.com/o/r/actions/runs/42',
  head_branch: 'main',
  head_sha: 'abc',
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
};
const job = (over: Partial<ApiJob>): ApiJob => ({
  id: 1,
  name: 'build',
  status: 'completed',
  runner_name: 'r',
  conclusion: 'success',
  created_at: '2026-01-01T00:00:00Z',
  started_at: '2026-01-01T00:00:12Z',
  completed_at: '2026-01-01T00:04:17Z',
  html_url: null,
  steps: [],
  ...over,
});

describe('summaryTable', () => {
  test('one row per job with queued time and duration', () => {
    const t = summaryTable(run, [job({ name: 'e2e (webkit)' })], null);
    expect(t).toContain('| Job | Result | Queued | Duration |');
    expect(t).toContain('| e2e (webkit) | success | 12s | 4m 05s |');
  });

  test('heading carries the conclusion and links the run', () => {
    expect(summaryTable(run, [], null).split('\n')[0]).toBe(
      '## ci: failure ([run 42](https://github.com/o/r/actions/runs/42))',
    );
  });

  test('report line: the url, or the artifact when there is none', () => {
    expect(summaryTable(run, [], null)).toContain('Report: see the `ci-run-report` artifact');
    expect(summaryTable(run, [], 'https://x.test/r')).toContain('Report: https://x.test/r');
  });

  test('a job without times shows a dash; a running job falls back to its status', () => {
    const t = summaryTable(
      run,
      [job({ conclusion: null, status: 'queued', started_at: null, completed_at: null })],
      null,
    );
    expect(t).toContain('| build | queued | – | – |');
  });

  test('pipes in names do not break the table', () => {
    expect(summaryTable(run, [job({ name: 'a|b' })], null)).toContain('| a\\|b |');
  });
});

describe('formatDuration', () => {
  test.each([
    [12, '12s'],
    [83, '1m 23s'],
    [245, '4m 05s'],
    [3723, '1h 02m 03s'],
    [-5, '0s'],
  ])('%d seconds', (s, text) => expect(formatDuration(s)).toBe(text));
});
