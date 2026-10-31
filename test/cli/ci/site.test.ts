import { expect, test } from 'vitest';
import type { ApiPull, ApiRun } from '../../../src/cli/ci/github-api.js';
import {
  applyRetention,
  channelFor,
  dropWorkflowChannels,
  placeRun,
  pullsOfRun,
  pullsToLink,
  removeChannel,
  renderLanding,
  renderRedirect,
  reportUrl,
  rollingInputs,
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
  head: { sha: 'abc', ref: 'feat', repo: { full_name: 'o/r' } },
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
const main = { kind: 'branch', title: 'main', headBranch: 'main' } as const;
const MAIN: string = 'branch/main';
const empty = (): SiteIndex => ({ version: 1, channels: {} });

test('channelFor: an open pull with the head sha is its pr channel', () => {
  expect(channelFor(apiRun({ head_branch: 'feat' }), [pull()], 'main')).toEqual({
    key: 'pr/12',
    channel: { kind: 'pr', title: '#12 Fix the thing', headBranch: 'feat', headRepo: 'o/r' },
  });
  const fork = pull({ head: { sha: 'abc', ref: 'feat', repo: { full_name: 'f/r' } } });
  expect(channelFor(apiRun({ head_branch: 'feat' }), [fork], 'main')?.channel.headRepo).toBe('f/r');
  const gone = pull({ head: { sha: 'abc', ref: 'feat', repo: null } });
  expect(channelFor(apiRun({ head_branch: 'feat' }), [gone], 'main')).toEqual({
    key: 'pr/12',
    channel: { kind: 'pr', title: '#12 Fix the thing', headBranch: 'feat' },
  });
});

test('channelFor: a default-branch run of this repo is its branch channel, whatever the workflow', () => {
  expect(channelFor(apiRun(), [], 'main')).toEqual({ key: 'branch/main', channel: main });
  expect(channelFor(apiRun({ name: 'Load Test!' }), [], 'main')?.key).toBe('branch/main');
  const run = apiRun({ head_branch: 'Release/1.x' });
  expect(channelFor(run, [], 'Release/1.x')).toEqual({
    key: 'branch/release-1-x',
    channel: { kind: 'branch', title: 'Release/1.x', headBranch: 'Release/1.x' },
  });
});

test('channelFor: a fork push with no pull, or a non-default branch, is not published', () => {
  expect(channelFor(apiRun({ head_repository: { full_name: 'x/r' } }), [], 'main')).toBeUndefined();
  expect(channelFor(apiRun({ head_repository: null }), [], 'main')).toBeUndefined();
  expect(channelFor(apiRun({ head_branch: 'feat' }), [], 'main')).toBeUndefined();
});

test('channelFor: closed pulls and pulls of another sha and branch are ignored', () => {
  expect(channelFor(apiRun({ head_branch: 'feat' }), [pull({ state: 'closed' })], 'main')).toBeUndefined();
  expect(
    channelFor(
      apiRun({ head_branch: 'feat' }),
      [pull({ head: { sha: 'zzz', ref: 'other', repo: { full_name: 'o/r' } } })],
      'main',
    ),
  ).toBeUndefined();
});

test('channelFor: a pull whose head moved on (same ref, new sha) still takes the run', () => {
  expect(
    channelFor(
      apiRun({ head_branch: 'feat' }),
      [pull({ head: { sha: 'zzz', ref: 'feat', repo: { full_name: 'o/r' } } })],
      'main',
    )?.key,
  ).toBe('pr/12');
});

test('channelFor: a fork pull from a branch of the same name does not take a default-branch run', () => {
  const fork = pull({ head: { sha: 'zzz', ref: 'main', repo: { full_name: 'fork/r' } } });
  expect(channelFor(apiRun(), [fork], 'main')?.key).toBe('branch/main');
  expect(pullsOfRun(apiRun(), [fork])).toEqual([]);
  expect(pullsOfRun(apiRun(), [pull({ head: { sha: 'zzz', ref: 'main', repo: null } })])).toEqual([]);
});

test('channelFor: a default-branch run goes to its branch channel even when an open pull has its commit', () => {
  // A pull request whose head is main (or contains main's head commit) must not capture main's runs.
  const fromMain = pull({ head: { sha: 'abc', ref: 'main', repo: { full_name: 'o/r' } } });
  const containing = pull({ number: 13, head: { sha: 'abc', ref: 'feat', repo: { full_name: 'o/r' } } });
  expect(channelFor(apiRun(), [fromMain, containing], 'main')).toEqual({ key: 'branch/main', channel: main });
  expect(pullsToLink(apiRun(), [fromMain, containing], 'main')).toEqual([]);
  expect(pullsToLink(apiRun({ head_branch: 'feat' }), [containing], 'main')).toEqual([containing]);
  // a fork's `main` is not the default branch
  const forkRun = apiRun({ head_repository: { full_name: 'fork/r' } });
  expect(pullsToLink(forkRun, [containing], 'main')).toEqual([containing]);
  expect(channelFor(forkRun, [containing], 'main')?.key).toBe('pr/13');
});

test('pullsOfRun prefers the exact-commit pull', () => {
  const run = apiRun({ head_branch: 'feat' });
  const moved = pull({ number: 1, head: { sha: 'zzz', ref: 'feat', repo: { full_name: 'o/r' } } });
  const exact = pull({ number: 2 });
  expect(pullsOfRun(run, [moved, exact]).map((p) => p.number)).toEqual([2, 1]);
  expect(channelFor(run, [moved, exact], 'main')?.key).toBe('pr/2');
});

test('placeRun: a stale run placed after a newer one stays behind it', () => {
  let ix = placeRun(empty(), MAIN, main, siteRun(5));
  ix = placeRun(ix, MAIN, main, siteRun(3));
  expect(ix.channels[MAIN]?.runs.map((r) => r.runId)).toEqual([5, 3]);
  ix = placeRun(ix, MAIN, main, siteRun(4, { completedAt: '2026-01-05T00:00:00Z' }));
  expect(ix.channels[MAIN]?.runs.map((r) => r.runId)).toEqual([5, 4, 3]);
});

test('placeRun: newest first; the same runId replaces in place', () => {
  let ix = placeRun(empty(), MAIN, main, siteRun(1));
  ix = placeRun(ix, MAIN, main, siteRun(2));
  expect(ix.channels[MAIN]?.runs.map((r) => r.runId)).toEqual([2, 1]);
  ix = placeRun(ix, MAIN, main, siteRun(1, { attempt: 2 }));
  expect(ix.channels[MAIN]?.runs.map((r) => [r.runId, r.attempt])).toEqual([
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

test('applyRetention keeps the newest runs of each workflow per channel, by channel kind', () => {
  let ix = empty();
  const w = (workflow: string | undefined) => (workflow === undefined ? {} : { workflow });
  for (const [id, wf] of [
    [1, 'ci'],
    [2, 'load'],
    [3, 'ci'],
    [4, 'ci'],
  ] as const)
    ix = placeRun(ix, MAIN, main, siteRun(id, { reportPath: `branch/main/runs/${id}`, ...w(wf) }));
  const pr = { kind: 'pr', title: '#12 x', headBranch: 'feat' } as const;
  for (const [id, wf] of [
    [5, undefined],
    [6, undefined],
    [7, 'ci'],
    [8, 'load'],
    [9, 'ci'],
  ] as const)
    ix = placeRun(ix, 'pr/12', pr, siteRun(id, { reportPath: `pr/12/runs/${id}`, ...w(wf) }));
  const r = applyRetention(ix, { branch: 2, pr: 1 });
  expect(r.remove.sort()).toEqual(['branch/main/runs/1', 'pr/12/runs/5', 'pr/12/runs/7']);
  expect(r.index.channels[MAIN]?.runs.map((x) => x.runId)).toEqual([4, 3, 2]);
  expect(r.index.channels['pr/12']?.runs.map((x) => x.runId)).toEqual([9, 8, 6]);
});

test('removeChannel returns the report paths; a missing key is a no-op', () => {
  const ix = placeRun(empty(), 'pr/12', { kind: 'pr', title: '#12 x', headBranch: 'f' }, siteRun(1));
  const r = removeChannel(ix, 'pr/12');
  expect(r.index.channels).toEqual({});
  expect(r.remove).toEqual(['ci/runs/1']);
  expect(removeChannel(ix, 'pr/99')).toEqual({ index: ix, remove: [] });
});

test('dropWorkflowChannels removes the older per-workflow channels and names their folders', () => {
  const wf = (title: string) => ({ kind: 'workflow', title, headBranch: 'main' }) as const;
  let ix = placeRun(empty(), 'ci', wf('ci'), siteRun(1));
  ix = placeRun(ix, 'load', wf('load'), siteRun(2, { reportPath: 'load/runs/2' }));
  ix = placeRun(ix, 'pr/3', { kind: 'pr', title: '#3', headBranch: 'old' }, siteRun(3));
  ix = placeRun(ix, MAIN, main, siteRun(4));
  const r = dropWorkflowChannels(ix);
  expect(r.remove.sort()).toEqual(['ci', 'load']);
  expect(Object.keys(r.index.channels).sort()).toEqual([MAIN, 'pr/3']);
  expect(dropWorkflowChannels(r.index)).toEqual({ index: r.index, remove: [] });
});

test('siteIndexSchema parses an index, the older channel kinds too, and rejects another version', () => {
  let ix = placeRun(empty(), MAIN, main, siteRun(1, { workflow: 'ci' }));
  ix = placeRun(ix, 'pr/3', { kind: 'pr', title: '#3', headBranch: 'b', headRepo: 'o/r' }, siteRun(2));
  ix = placeRun(ix, 'ci', { kind: 'workflow', title: 'ci', headBranch: 'main' }, siteRun(3));
  expect(siteIndexSchema.parse(JSON.parse(JSON.stringify(ix)))).toEqual(ix);
  expect(siteIndexSchema.safeParse({ version: 2, channels: {} }).success).toBe(false);
  // a stub-era pr channel, with no workflow on its runs, reads as a pr channel
  const legacy = {
    version: 1,
    channels: { 'pr/7': { kind: 'pr', title: '#7', headBranch: 'b', runs: [siteRun(5)] } },
  };
  expect(siteIndexSchema.parse(legacy).channels['pr/7']?.kind).toBe('pr');
});

test('renderLanding lists the branches, then pull requests newest first, has no script, and escapes titles', () => {
  let ix = placeRun(empty(), MAIN, main, siteRun(1));
  ix = placeRun(
    ix,
    'pr/12',
    { kind: 'pr', title: '#12 <img src=x onerror=1> & "q"', headBranch: 'feat' },
    siteRun(2),
  );
  ix = placeRun(
    ix,
    'pr/20',
    { kind: 'pr', title: '#20 Fork', headBranch: 'y', headRepo: 'f/r' },
    siteRun(3, { conclusion: 'failure' }),
  );
  ix = placeRun(ix, 'ci', { kind: 'workflow', title: 'ci', headBranch: 'main' }, siteRun(4));
  const html = renderLanding(ix, 'o/<r>');
  expect(html).toContain('<h2>Branches</h2>');
  expect(html).toMatch(/<a href="branch\/main\/">main<\/a>/);
  expect(html).toContain('<h2>Pull requests</h2>');
  expect(html).toContain('#12 &lt;img src=x onerror=1&gt; &amp; &quot;q&quot;');
  expect(html).toContain('f:y');
  expect(html).toContain('failure');
  expect(html).toContain('o/&lt;r&gt;');
  expect(html).not.toContain('href="ci/"');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<script');
  const order = ['branch/main/', 'pr/20/', 'pr/12/'].map((h) => html.indexOf(`href="${h}"`));
  expect(order.every((i) => i > 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test('slug and reportUrl', () => {
  expect(slug('ci')).toBe('ci');
  expect(slug('Perf / Load')).toBe('perf-load');
  expect(slug('feat/Big Thing')).toBe('feat-big-thing');
  expect(slug('pr')).toBe('pr');
  expect(slug('--')).toBe('workflow');
  expect(reportUrl('https://o.github.io/r', 'pr/1/runs/1')).toBe('https://o.github.io/r/pr/1/runs/1/');
});

test('renderRedirect refreshes to the target', () => {
  const html = renderRedirect('runs/123/');
  expect(html).toContain('url=runs/123/');
  expect(html).toContain('<a href="runs/123/">');
  expect(renderRedirect('a"><script>')).not.toContain('<script');
});

test('rollingInputs lists the report paths oldest first', () => {
  const r = (runId: number): SiteRun => ({
    runId,
    attempt: 1,
    conclusion: 'success',
    headSha: 'a',
    headBranch: 'main',
    completedAt: '2026-01-01T00:00:00Z',
    runUrl: 'u',
    reportPath: `ci/runs/${runId}`,
  });
  const channel = { kind: 'workflow' as const, title: 'ci', headBranch: 'main', runs: [r(3), r(2), r(1)] };
  expect(rollingInputs(channel)).toEqual(['ci/runs/1', 'ci/runs/2', 'ci/runs/3']);
  expect(channel.runs.map((x) => x.runId)).toEqual([3, 2, 1]);
});
