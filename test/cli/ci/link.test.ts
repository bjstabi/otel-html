import { describe, expect, test } from 'vitest';
import type { ApiJob, ApiRun } from '../../../src/cli/ci/github-api.js';
import {
  branchPage,
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
  test("links the branch's rolling page and labels the previous run with its workflow", () => {
    const body = commentBody(
      run,
      jobs,
      'https://x.test/branch/feat/runs/5/',
      { runId: 4, url: 'https://x.test/branch/feat/runs/4/', workflow: 'load' },
      { branch: 'feat/x', url: 'https://x.test/branch/feat/' },
    );
    expect(body).toContain('Report: https://x.test/branch/feat/runs/5/');
    expect(body).toContain('All runs on `feat/x`: https://x.test/branch/feat/');
    expect(body).toContain('Previous run: [load run 4](https://x.test/branch/feat/runs/4/)');
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

describe('branchPage', () => {
  const r = (runId: number): SiteRun => ({ ...siteRun(runId), reportPath: `branch/feat-x/runs/${runId}` });
  const index: SiteIndex = {
    version: 1,
    channels: {
      'branch/feat-x': {
        kind: 'branch',
        title: '#7',
        headBranch: 'feat/x',
        pr: 7,
        headRepo: 'o/r',
        runs: [
          { ...r(5), workflow: 'ci' },
          { ...r(4), workflow: 'load' },
        ],
      },
      'pr/8': {
        kind: 'pr',
        title: '#8',
        headBranch: 'b',
        runs: [{ ...siteRun(9), reportPath: 'pr/8/runs/9' }],
      },
    },
  };
  test("is the branch channel's rolling page, from this run's URL", () => {
    expect(branchPage(index, 5, 'https://x.test/base/branch/feat-x/runs/5/')).toEqual({
      branch: 'feat/x',
      url: 'https://x.test/base/branch/feat-x/',
    });
  });
  test('is undefined off a branch channel, for an unknown run or a foreign URL', () => {
    expect(branchPage(index, 9, 'https://x.test/pr/8/runs/9/')).toBeUndefined();
    expect(branchPage(index, 1, 'https://x.test/branch/feat-x/runs/1/')).toBeUndefined();
    expect(branchPage(index, 5, 'https://x.test/elsewhere/')).toBeUndefined();
  });
  test('previousRun carries the workflow of the run before, of any workflow', () => {
    expect(previousRun(index, 5, 'https://x.test/branch/feat-x/runs/5/')).toEqual({
      runId: 4,
      url: 'https://x.test/branch/feat-x/runs/4/',
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
