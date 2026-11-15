import { describe, expect, test } from 'vitest';
import type { ApiRun } from '../../../src/cli/ci/github-api.js';
import { isTrustedRun } from '../../../src/cli/ci/trust.js';

const run = (over: Partial<ApiRun> = {}): ApiRun => ({
  id: 1,
  run_attempt: 1,
  name: 'ci',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-10T11:00:00Z',
  run_started_at: '2026-11-10T11:00:00Z',
  updated_at: '2026-11-10T11:10:00Z',
  html_url: 'https://github.com/o/r/actions/runs/1',
  path: '.github/workflows/ci.yml',
  actor: { type: 'User' },
  head_branch: 'main',
  head_sha: 'sha1',
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
  head_repository: { full_name: 'o/r' },
  ...over,
});

const trusted = (r: ApiRun): boolean => isTrustedRun(r, 'o/r', 'main');

describe('isTrustedRun', () => {
  test('a push on the default branch by a bot', () => {
    expect(trusted(run({ actor: { type: 'Bot' } }))).toBe(true);
  });
  test('a schedule on the default branch', () => {
    expect(trusted(run({ event: 'schedule', actor: { type: 'Bot' } }))).toBe(true);
  });
  test('a same-repository pull request by a user', () => {
    expect(trusted(run({ event: 'pull_request', head_branch: 'feat' }))).toBe(true);
  });
  test('not a fork pull request by a user', () => {
    expect(
      trusted(run({ event: 'pull_request', head_branch: 'feat', head_repository: { full_name: 'f/r' } })),
    ).toBe(false);
  });
  test('not a same-repository pull request by a bot', () => {
    expect(trusted(run({ event: 'pull_request', head_branch: 'feat', actor: { type: 'Bot' } }))).toBe(false);
  });
  test('not a bot pull request whose head branch is named like the default branch', () => {
    expect(trusted(run({ event: 'pull_request', head_branch: 'main', actor: { type: 'Bot' } }))).toBe(false);
  });
  test('not a run without a head repository', () => {
    expect(trusted(run({ head_repository: null }))).toBe(false);
  });
});
