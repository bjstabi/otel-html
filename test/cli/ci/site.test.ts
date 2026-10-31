import { expect, test } from 'vitest';
import type { ApiPull, ApiRun } from '../../../src/cli/ci/github-api.js';
import {
  applyRetention,
  channelFor,
  placeRun,
  removeChannel,
  renderLanding,
  renderRedirect,
  reportUrl,
  type SiteIndex,
  type SiteRun,
  siteIndexSchema,
  slug,
} from '../../../src/cli/ci/site.js';

const apiRun = (over: Partial<ApiRun> = {}): ApiRun => ({
  id: 1,
  run_attempt: 1,
  name: 'ci',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-01-01T00:00:00Z',
  run_started_at: null,
  updated_at: '2026-01-01T00:01:00Z',
  html_url: 'https://github.com/o/r/actions/runs/1',
  head_branch: 'main',
  head_sha: 'abc',
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
  head_repository: { full_name: 'o/r' },
  ...over,
});
const pull = (over: Partial<ApiPull> = {}): ApiPull => ({
  number: 12,
  title: 'Fix the thing',
  state: 'open',
  head: { sha: 'abc', ref: 'feat' },
  ...over,
});
const siteRun = (runId: number, over: Partial<SiteRun> = {}): SiteRun => ({
  runId,
  attempt: 1,
  conclusion: 'success',
  headSha: 'abc',
  headBranch: 'main',
  completedAt: `2026-01-0${runId}T00:00:00Z`,
  runUrl: `https://github.com/o/r/actions/runs/${runId}`,
  reportPath: `ci/runs/${runId}`,
  ...over,
});
const ci = { kind: 'workflow', title: 'ci', headBranch: 'main' } as const;
const CI: string = 'ci';
const empty = (): SiteIndex => ({ version: 1, channels: {} });

test('channelFor: an open pull with the head sha is a pr channel', () => {
  expect(channelFor(apiRun({ head_branch: 'feat' }), [pull()], 'main')).toEqual({
    key: 'pr/12',
    channel: { kind: 'pr', title: '#12 Fix the thing', headBranch: 'feat' },
  });
});

test('channelFor: a default-branch run of this repo is a workflow channel', () => {
  expect(channelFor(apiRun(), [], 'main')).toEqual({ key: 'ci', channel: ci });
  expect(channelFor(apiRun({ name: 'Load Test!' }), [], 'main')?.key).toBe('load-test');
});

test('channelFor: a fork push with no pull, or a non-default branch, is not published', () => {
  expect(channelFor(apiRun({ head_repository: { full_name: 'x/r' } }), [], 'main')).toBeUndefined();
  expect(channelFor(apiRun({ head_repository: null }), [], 'main')).toBeUndefined();
  expect(channelFor(apiRun({ head_branch: 'feat' }), [], 'main')).toBeUndefined();
});

test('channelFor: closed pulls and pulls for another sha are ignored', () => {
  expect(channelFor(apiRun({ head_branch: 'feat' }), [pull({ state: 'closed' })], 'main')).toBeUndefined();
  expect(
    channelFor(apiRun({ head_branch: 'feat' }), [pull({ head: { sha: 'zzz', ref: 'feat' } })], 'main'),
  ).toBeUndefined();
});

test('placeRun: newest first; the same runId replaces in place', () => {
  let ix = placeRun(empty(), 'ci', ci, siteRun(1));
  ix = placeRun(ix, 'ci', ci, siteRun(2));
  expect(ix.channels[CI]?.runs.map((r) => r.runId)).toEqual([2, 1]);
  ix = placeRun(ix, 'ci', ci, siteRun(1, { attempt: 2 }));
  expect(ix.channels[CI]?.runs.map((r) => [r.runId, r.attempt])).toEqual([
    [2, 1],
    [1, 2],
  ]);
});

test('placeRun creates a channel that was removed meanwhile, without mutating the input', () => {
  const before = empty();
  const after = placeRun(before, 'pr/12', { kind: 'pr', title: '#12 x', headBranch: 'feat' }, siteRun(1));
  expect(Object.keys(before.channels)).toEqual([]);
  expect(after.channels['pr/12']?.runs).toHaveLength(1);
});

test('applyRetention drops the oldest runs per channel kind', () => {
  let ix = empty();
  for (const id of [1, 2, 3]) ix = placeRun(ix, 'ci', ci, siteRun(id));
  const pr = { kind: 'pr', title: '#12 x', headBranch: 'feat' } as const;
  for (const id of [4, 5]) ix = placeRun(ix, 'pr/12', pr, siteRun(id, { reportPath: `pr/12/runs/${id}` }));
  const r = applyRetention(ix, { workflow: 2, pr: 1 });
  expect(r.remove.sort()).toEqual(['ci/runs/1', 'pr/12/runs/4']);
  expect(r.index.channels[CI]?.runs.map((x) => x.runId)).toEqual([3, 2]);
  expect(r.index.channels['pr/12']?.runs.map((x) => x.runId)).toEqual([5]);
});

test('removeChannel returns the report paths; a missing key is a no-op', () => {
  const ix = placeRun(empty(), 'pr/12', { kind: 'pr', title: '#12 x', headBranch: 'f' }, siteRun(1));
  const r = removeChannel(ix, 'pr/12');
  expect(r.index.channels).toEqual({});
  expect(r.remove).toEqual(['ci/runs/1']);
  expect(removeChannel(ix, 'pr/99')).toEqual({ index: ix, remove: [] });
});

test('siteIndexSchema parses an index and rejects another version', () => {
  const ix = placeRun(empty(), 'ci', ci, siteRun(1));
  expect(siteIndexSchema.parse(JSON.parse(JSON.stringify(ix)))).toEqual(ix);
  expect(siteIndexSchema.safeParse({ version: 2, channels: {} }).success).toBe(false);
});

test('renderLanding links main and each PR, has no script, and escapes titles', () => {
  let ix = placeRun(empty(), 'ci', ci, siteRun(1));
  ix = placeRun(
    ix,
    'pr/12',
    { kind: 'pr', title: '#12 <img src=x onerror=1> & "q"', headBranch: 'feat' },
    siteRun(2),
  );
  const html = renderLanding(ix, 'o/<r>');
  expect(html).toMatch(/<a href="ci\/">main<\/a>/);
  expect(html).toContain('href="pr/12/"');
  expect(html).toContain('#12 &lt;img src=x onerror=1&gt; &amp; &quot;q&quot;');
  expect(html).toContain('o/&lt;r&gt;');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<script');
});

test('renderRedirect refreshes to the target', () => {
  const html = renderRedirect('runs/123/');
  expect(html).toContain('url=runs/123/');
  expect(html).toContain('<a href="runs/123/">');
  expect(renderRedirect('a"><script>')).not.toContain('<script');
});

test('slug and reportUrl', () => {
  expect(slug('ci')).toBe('ci');
  expect(slug('Perf / Load')).toBe('perf-load');
  expect(reportUrl('https://o.github.io/r', 'ci/runs/1')).toBe('https://o.github.io/r/ci/runs/1/');
});
