import { describe, expect, test } from 'vitest';
import type { ApiJob, ApiRun } from '../../../src/cli/ci/github-api.js';
import {
  channelPageOf,
  checkRunPayload,
  commentBody,
  findStickyComment,
  previousRunOf,
} from '../../../src/cli/ci/link.js';
import type { SiteIndex, SiteRun } from '../../../src/cli/ci/site.js';

const run = {
  id: 5,
  run_attempt: 1,
  name: 'ci',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/o/r/actions/runs/5',
  head_sha: 'abc',
} as ApiRun;
const jobs: ApiJob[] = [];

const siteRun = (runId: number): SiteRun => ({
  runId,
  attempt: 1,
  conclusion: 'success',
  headSha: 'x',
  headBranch: 'b',
  completedAt: '2026-01-01T00:00:00Z',
  runUrl: 'u',
  reportPath: `pr/7/runs/${runId}`,
});

describe('commentBody', () => {
  test('starts with the marker and names the previous run', () => {
    const body = commentBody(run, jobs, 'https://x.test/pr/7/runs/5/', {
      runId: 4,
      url: 'https://x.test/pr/7/runs/4/',
    });
    expect(body.split('\n')[0]).toBe('<!-- otel-html-report:ci -->');
    expect(body).toContain('Report: https://x.test/pr/7/runs/5/');
    expect(body).toContain('Previous run: [run 4](https://x.test/pr/7/runs/4/)');
  });
  test('has no previous line without a previous run', () => {
    expect(commentBody(run, jobs, 'https://x.test/r/', undefined)).not.toContain('Previous run');
  });
  test("links the channel's rolling page and labels the previous run with its workflow", () => {
    const body = commentBody(
      run,
      jobs,
      'https://x.test/pr/7/runs/5/',
      { runId: 4, url: 'https://x.test/pr/7/runs/4/', workflow: 'load' },
      { label: 'pull request #7', url: 'https://x.test/pr/7/' },
    );
    expect(body).toContain('Report: https://x.test/pr/7/runs/5/');
    expect(body).toContain('All runs on pull request #7: https://x.test/pr/7/');
    expect(body).toContain('Previous run: [load run 4](https://x.test/pr/7/runs/4/)');
    expect(body.indexOf('All runs on')).toBeGreaterThan(body.indexOf('Report:'));
    expect(commentBody(run, jobs, 'https://x.test/r/', undefined)).not.toContain('All runs on');
  });
});

const bot = { login: 'github-actions[bot]', type: 'Bot' };
const human = { login: 'someone', type: 'User' };

test('findStickyComment picks the comment carrying the workflow marker', () => {
  const comments = [
    { id: 1, body: 'hello', user: bot },
    { id: 2, body: '<!-- otel-html-report:load -->\nreport', user: bot },
    { id: 3, body: '<!-- otel-html-report:ci -->\nreport', user: bot },
  ];
  expect(findStickyComment(comments, 'ci')).toBe(3);
  expect(findStickyComment(comments, 'load')).toBe(2);
  expect(findStickyComment(comments, 'other')).toBeUndefined();
});

test('the old bare marker belongs to the ci workflow only', () => {
  const comments = [{ id: 1, body: '<!-- otel-html-report -->\nold', user: bot }];
  expect(findStickyComment(comments, 'ci')).toBe(1);
  expect(findStickyComment(comments, 'load')).toBeUndefined();
});

test("findStickyComment never takes a person's comment that carries the marker", () => {
  const comments = [
    { id: 1, body: 'quoting it: <!-- otel-html-report:ci -->', user: human },
    { id: 2, body: '<!-- otel-html-report -->\nold', user: human },
    { id: 3, body: '<!-- otel-html-report:ci -->', user: null },
  ];
  expect(findStickyComment(comments, 'ci')).toBeUndefined();
  expect(
    findStickyComment([...comments, { id: 4, body: '<!-- otel-html-report:ci -->', user: bot }], 'ci'),
  ).toBe(4);
});

test('checkRunPayload is a neutral completed check linking the report', () => {
  const p = checkRunPayload(run, 'https://x.test/r/');
  expect(p).toMatchObject({
    name: 'otel-html report',
    head_sha: 'abc',
    status: 'completed',
    conclusion: 'neutral',
    details_url: 'https://x.test/r/',
  });
  expect(p.output.summary).toContain('https://x.test/r/');
});

describe('previousRunOf and channelPageOf (the live index, D57)', () => {
  const entry = (runId: number, workflow: string, conclusion = 'success'): SiteRun => ({
    ...siteRun(runId),
    workflow,
    conclusion,
  });
  const index = (runs: SiteRun[]): SiteIndex => ({
    version: 1,
    channels: { 'pr/7': { kind: 'pr', title: '#7 Fix', headBranch: 'topic', runs } },
  });

  test('skips this run and an in-progress run, and prefers the same workflow', () => {
    const idx = index([
      entry(9, 'ci'),
      entry(8, 'load'),
      entry(7, 'ci', 'in_progress'),
      entry(6, 'load'),
      entry(5, 'ci'),
    ]);
    expect(previousRunOf(idx, 'pr/7', 9, 'https://x.test', 'ci')).toEqual({
      runId: 5,
      url: 'https://x.test/pr/7/runs/5/',
      workflow: 'ci',
    });
    expect(previousRunOf(idx, 'pr/7', 9, 'https://x.test', 'other')?.runId).toBe(8);
    expect(previousRunOf(index([entry(9, 'ci')]), 'pr/7', 9, 'https://x.test', 'ci')).toBeUndefined();
    expect(previousRunOf(idx, 'pr/8', 9, 'https://x.test', 'ci')).toBeUndefined();
  });

  test('matches the raw workflow name, as the index stores it', () => {
    const idx = index([entry(9, 'Load test'), entry(8, 'CI'), entry(7, 'Load test')]);
    expect(previousRunOf(idx, 'pr/7', 9, 'https://x.test', 'Load test')?.runId).toBe(7);
  });

  test('names the channel page from the channel, whether or not the index lists the run', () => {
    expect(
      channelPageOf('pr/7', { kind: 'pr', title: '#7 Fix', headBranch: 'topic' }, 'https://x.test'),
    ).toEqual({ label: 'pull request #7', url: 'https://x.test/pr/7/' });
    expect(
      channelPageOf('branch/main', { kind: 'branch', title: 'main', headBranch: 'main' }, 'https://x.test'),
    ).toEqual({ label: '`main`', url: 'https://x.test/branch/main/' });
  });

  test('fences a branch name holding backticks with more of them', () => {
    const label = (headBranch: string): string | undefined =>
      channelPageOf('branch/b', { kind: 'branch', title: headBranch, headBranch }, 'https://x.test')?.label;
    expect(label('a`b')).toBe('``a`b``');
    expect(label('x``y`')).toBe('``` x``y` ```');
  });

  test('has no page for an older per-workflow channel', () => {
    expect(channelPageOf('ci', { kind: 'workflow', title: 'ci', headBranch: 'main' }, 'https://x.test')).toBe(
      undefined,
    );
  });
});
