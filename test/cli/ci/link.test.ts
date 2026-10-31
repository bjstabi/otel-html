import { describe, expect, test } from 'vitest';
import type { ApiJob, ApiRun } from '../../../src/cli/ci/github-api.js';
import {
  channelPage,
  checkRunPayload,
  commentBody,
  findStickyComment,
  previousRun,
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
      { label: 'this pull request', url: 'https://x.test/pr/7/' },
    );
    expect(body).toContain('Report: https://x.test/pr/7/runs/5/');
    expect(body).toContain('All runs on this pull request: https://x.test/pr/7/');
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

describe('channelPage', () => {
  const r = (runId: number, workflow: string): SiteRun => ({
    ...siteRun(runId),
    reportPath: `pr/7/runs/${runId}`,
    workflow,
  });
  const index: SiteIndex = {
    version: 1,
    channels: {
      'pr/7': {
        kind: 'pr',
        title: '#7',
        headBranch: 'feat/x',
        headRepo: 'o/r',
        runs: [r(5, 'ci'), r(4, 'load')],
      },
      'branch/main': {
        kind: 'branch',
        title: 'main',
        headBranch: 'main',
        runs: [{ ...siteRun(9), reportPath: 'branch/main/runs/9' }],
      },
      ci: {
        kind: 'workflow',
        title: 'ci',
        headBranch: 'main',
        runs: [{ ...siteRun(8), reportPath: 'ci/runs/8' }],
      },
    },
  };
  test("is the pull request's rolling page, from this run's URL", () => {
    expect(channelPage(index, 5, 'https://x.test/base/pr/7/runs/5/')).toEqual({
      label: 'this pull request',
      url: 'https://x.test/base/pr/7/',
    });
  });
  test("is the branch's rolling page, the branch a code span", () => {
    expect(channelPage(index, 9, 'https://x.test/branch/main/runs/9/')).toEqual({
      label: '`main`',
      url: 'https://x.test/branch/main/',
    });
  });
  test('fences a branch name holding backticks with more of them', () => {
    const named = (headBranch: string): SiteIndex => ({
      version: 1,
      channels: {
        'branch/b': {
          kind: 'branch',
          title: headBranch,
          headBranch,
          runs: [{ ...siteRun(1), reportPath: 'branch/b/runs/1' }],
        },
      },
    });
    expect(channelPage(named('a`b'), 1, 'https://x.test/branch/b/runs/1/')?.label).toBe('`` a`b ``');
    expect(channelPage(named('x``y`'), 1, 'https://x.test/branch/b/runs/1/')?.label).toBe('``` x``y` ```');
  });
  test('is undefined on an older workflow channel, for an unknown run or a foreign URL', () => {
    expect(channelPage(index, 8, 'https://x.test/ci/runs/8/')).toBeUndefined();
    expect(channelPage(index, 1, 'https://x.test/pr/7/runs/1/')).toBeUndefined();
    expect(channelPage(index, 5, 'https://x.test/elsewhere/')).toBeUndefined();
  });
  test("previousRun prefers the channel's previous run of the same workflow", () => {
    const mixed: SiteIndex = {
      version: 1,
      channels: {
        'pr/7': {
          kind: 'pr',
          title: '#7',
          headBranch: 'feat/x',
          runs: [r(6, 'ci'), r(5, 'load'), r(4, 'ci'), r(3, 'load')],
        },
      },
    };
    expect(previousRun(mixed, 6, 'https://x.test/pr/7/runs/6/')).toEqual({
      runId: 4,
      url: 'https://x.test/pr/7/runs/4/',
      workflow: 'ci',
    });
    // no earlier run of its workflow: the run before it, of any workflow
    expect(previousRun(mixed, 4, 'https://x.test/pr/7/runs/4/')?.runId).toBe(3);
    expect(previousRun(index, 5, 'https://x.test/pr/7/runs/5/')).toEqual({
      runId: 4,
      url: 'https://x.test/pr/7/runs/4/',
      workflow: 'load',
    });
  });
});

describe('previousRun', () => {
  const index: SiteIndex = {
    version: 1,
    channels: { 'pr/7': { kind: 'pr', title: '#7', headBranch: 'b', runs: [siteRun(5), siteRun(4)] } },
  };
  test('is the entry after the run, with its report URL', () => {
    expect(previousRun(index, 5, 'https://x.test/base/pr/7/runs/5/')).toEqual({
      runId: 4,
      url: 'https://x.test/base/pr/7/runs/4/',
    });
  });
  test('is undefined for the oldest run, an unknown run or a foreign URL', () => {
    expect(previousRun(index, 4, 'https://x.test/pr/7/runs/4/')).toBeUndefined();
    expect(previousRun(index, 9, 'https://x.test/pr/7/runs/9/')).toBeUndefined();
    expect(previousRun(index, 5, 'https://x.test/elsewhere/')).toBeUndefined();
  });
});
