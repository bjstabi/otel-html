import { describe, expect, test } from 'vitest';
import type { ApiJob, ApiRun } from '../../../src/cli/ci/github-api.js';
import {
  checkRunPayload,
  commentBody,
  findStickyComment,
  MARKER,
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
    expect(body.split('\n')[0]).toBe(MARKER);
    expect(body).toContain('Report: https://x.test/pr/7/runs/5/');
    expect(body).toContain('Previous run: [run 4](https://x.test/pr/7/runs/4/)');
  });
  test('has no previous line without a previous run', () => {
    expect(commentBody(run, jobs, 'https://x.test/r/', undefined)).not.toContain('Previous run');
  });
});

test('findStickyComment picks the comment carrying the marker', () => {
  expect(
    findStickyComment([
      { id: 1, body: 'hello' },
      { id: 2, body: `${MARKER}\nreport` },
    ]),
  ).toBe(2);
  expect(findStickyComment([{ id: 1, body: 'hello' }])).toBeUndefined();
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
