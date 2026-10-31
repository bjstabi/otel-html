import { expect, test } from 'vitest';
import type { ApiPull, ApiRun } from '../../../src/cli/ci/github-api.js';
import {
  applyRetention,
  channelFor,
  placeRun,
  pullsOfRun,
  pullsToLink,
  removeChannel,
  removePr,
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
const ci = { kind: 'workflow', title: 'ci', headBranch: 'main' } as const;
const CI: string = 'ci';
const empty = (): SiteIndex => ({ version: 1, channels: {} });

test('channelFor: an open pull with the head sha is its branch channel', () => {
  expect(channelFor(apiRun({ head_branch: 'feat' }), [pull()], 'main')).toEqual({
    key: 'branch/feat',
    channel: { kind: 'branch', title: '#12 Fix the thing', headBranch: 'feat', pr: 12, headRepo: 'o/r' },
  });
  const nested = pull({ head: { sha: 'abc', ref: 'Feat/Big Thing', repo: { full_name: 'o/r' } } });
  expect(channelFor(apiRun({ head_branch: 'Feat/Big Thing' }), [nested], 'main')?.key).toBe(
    'branch/feat-big-thing',
  );
});

test('channelFor: a fork pull is keyed by owner and branch, never a same-repo key', () => {
  const fork = pull({ head: { sha: 'abc', ref: 'feat', repo: { full_name: 'Some.One/r' } } });
  const forkRun = apiRun({ head_branch: 'feat', head_repository: { full_name: 'Some.One/r' } });
  expect(channelFor(forkRun, [fork], 'main')).toEqual({
    key: 'branch/some-one--feat',
    channel: {
      kind: 'branch',
      title: '#12 Fix the thing',
      headBranch: 'feat',
      pr: 12,
      headRepo: 'Some.One/r',
    },
  });
  // a pull whose head repository is gone gets a key of its own
  const gone = pull({ head: { sha: 'abc', ref: 'feat', repo: null } });
  expect(channelFor(apiRun({ head_branch: 'feat' }), [gone], 'main')?.key).toBe('branch/feat--pr-12');
});

test('channelFor: a branch that slugs to a key another branch holds gets the pull number appended', () => {
  const channel = { kind: 'branch', title: '#3 x', headBranch: 'feat/x', pr: 3, headRepo: 'o/r' } as const;
  const ix = placeRun(empty(), 'branch/feat-x', channel, siteRun(1, { reportPath: 'branch/feat-x/runs/1' }));
  const other = pull({ number: 4, head: { sha: 'abc', ref: 'feat-x', repo: { full_name: 'o/r' } } });
  expect(channelFor(apiRun({ head_branch: 'feat-x' }), [other], 'main', ix)?.key).toBe('branch/feat-x--pr-4');
  // the same branch (a later run, or a new pull from it) keeps the key
  const same = pull({ number: 5, head: { sha: 'abc', ref: 'feat/x', repo: { full_name: 'o/r' } } });
  expect(channelFor(apiRun({ head_branch: 'feat/x' }), [same], 'main', ix)).toEqual({
    key: 'branch/feat-x',
    channel: { ...channel, title: '#5 Fix the thing', pr: 5 },
  });
  // the same branch name in a fork is another key anyway
  const fork = pull({ number: 6, head: { sha: 'abc', ref: 'feat/x', repo: { full_name: 'f/r' } } });
  expect(channelFor(apiRun({ head_branch: 'feat/x' }), [fork], 'main', ix)?.key).toBe('branch/f--feat-x');
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
  ).toBe('branch/feat');
});

test('channelFor: a fork pull from a branch of the same name does not take a default-branch run', () => {
  const fork = pull({ head: { sha: 'zzz', ref: 'main', repo: { full_name: 'fork/r' } } });
  expect(channelFor(apiRun(), [fork], 'main')?.key).toBe('ci');
  expect(pullsOfRun(apiRun(), [fork])).toEqual([]);
  expect(pullsOfRun(apiRun(), [pull({ head: { sha: 'zzz', ref: 'main', repo: null } })])).toEqual([]);
});

test('channelFor: a default-branch run goes to its workflow channel even when an open pull has its commit', () => {
  // A pull request whose head is main (or contains main's head commit) must not capture main's runs.
  const fromMain = pull({ head: { sha: 'abc', ref: 'main', repo: { full_name: 'o/r' } } });
  const containing = pull({ number: 13, head: { sha: 'abc', ref: 'feat', repo: { full_name: 'o/r' } } });
  expect(channelFor(apiRun(), [fromMain, containing], 'main')).toEqual({ key: 'ci', channel: ci });
  expect(pullsToLink(apiRun(), [fromMain, containing], 'main')).toEqual([]);
  expect(pullsToLink(apiRun({ head_branch: 'feat' }), [containing], 'main')).toEqual([containing]);
  // a fork's `main` is not the default branch
  const forkRun = apiRun({ head_repository: { full_name: 'fork/r' } });
  expect(pullsToLink(forkRun, [containing], 'main')).toEqual([containing]);
  expect(channelFor(forkRun, [containing], 'main')?.key).toBe('branch/feat');
});

test('pullsOfRun prefers the exact-commit pull', () => {
  const run = apiRun({ head_branch: 'feat' });
  const moved = pull({ number: 1, head: { sha: 'zzz', ref: 'feat', repo: { full_name: 'o/r' } } });
  const exact = pull({ number: 2 });
  expect(pullsOfRun(run, [moved, exact]).map((p) => p.number)).toEqual([2, 1]);
  expect(channelFor(run, [moved, exact], 'main')?.channel.pr).toBe(2);
});

test('placeRun: a stale run placed after a newer one stays behind it', () => {
  let ix = placeRun(empty(), 'ci', ci, siteRun(5));
  ix = placeRun(ix, 'ci', ci, siteRun(3));
  expect(ix.channels[CI]?.runs.map((r) => r.runId)).toEqual([5, 3]);
  ix = placeRun(ix, 'ci', ci, siteRun(4, { completedAt: '2026-01-05T00:00:00Z' }));
  expect(ix.channels[CI]?.runs.map((r) => r.runId)).toEqual([5, 4, 3]);
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

test('applyRetention drops the oldest runs per channel kind; branch and legacy pr channels keep `pr`', () => {
  let ix = empty();
  for (const id of [1, 2, 3]) ix = placeRun(ix, 'ci', ci, siteRun(id));
  const pr = { kind: 'pr', title: '#12 x', headBranch: 'feat' } as const;
  for (const id of [4, 5]) ix = placeRun(ix, 'pr/12', pr, siteRun(id, { reportPath: `pr/12/runs/${id}` }));
  const br = { kind: 'branch', title: '#13 y', headBranch: 'y', pr: 13, headRepo: 'o/r' } as const;
  for (const id of [6, 7])
    ix = placeRun(ix, 'branch/y', br, siteRun(id, { reportPath: `branch/y/runs/${id}` }));
  const r = applyRetention(ix, { workflow: 2, pr: 1 });
  expect(r.remove.sort()).toEqual(['branch/y/runs/6', 'ci/runs/1', 'pr/12/runs/4']);
  expect(r.index.channels[CI]?.runs.map((x) => x.runId)).toEqual([3, 2]);
  expect(r.index.channels['pr/12']?.runs.map((x) => x.runId)).toEqual([5]);
  expect(r.index.channels['branch/y']?.runs.map((x) => x.runId)).toEqual([7]);
});

test('removePr removes every channel of the pull request and its legacy pr channel', () => {
  const br = (pr: number) =>
    ({ kind: 'branch', title: `#${pr}`, headBranch: 'b', pr, headRepo: 'o/r' }) as const;
  let ix = placeRun(empty(), 'ci', ci, siteRun(1));
  ix = placeRun(ix, 'branch/a', br(7), siteRun(2, { reportPath: 'branch/a/runs/2' }));
  ix = placeRun(ix, 'branch/a--pr-7', br(7), siteRun(3, { reportPath: 'branch/a--pr-7/runs/3' }));
  ix = placeRun(ix, 'branch/b', br(8), siteRun(4, { reportPath: 'branch/b/runs/4' }));
  ix = placeRun(
    ix,
    'pr/7',
    { kind: 'pr', title: '#7', headBranch: 'a' },
    siteRun(5, { reportPath: 'pr/7/runs/5' }),
  );
  const r = removePr(ix, 7);
  expect(r.keys.sort()).toEqual(['branch/a', 'branch/a--pr-7', 'pr/7']);
  expect(r.remove.sort()).toEqual(['branch/a--pr-7/runs/3', 'branch/a/runs/2', 'pr/7/runs/5']);
  expect(Object.keys(r.index.channels).sort()).toEqual(['branch/b', 'ci']);
  expect(removePr(ix, 99)).toEqual({ index: ix, remove: [], keys: [] });
});

test('removeChannel returns the report paths; a missing key is a no-op', () => {
  const ix = placeRun(empty(), 'pr/12', { kind: 'pr', title: '#12 x', headBranch: 'f' }, siteRun(1));
  const r = removeChannel(ix, 'pr/12');
  expect(r.index.channels).toEqual({});
  expect(r.remove).toEqual(['ci/runs/1']);
  expect(removeChannel(ix, 'pr/99')).toEqual({ index: ix, remove: [] });
});

test('siteIndexSchema parses an index and rejects another version', () => {
  let ix = placeRun(empty(), 'ci', ci, siteRun(1, { workflow: 'ci' }));
  ix = placeRun(ix, 'pr/3', { kind: 'pr', title: '#3', headBranch: 'old' }, siteRun(2));
  ix = placeRun(
    ix,
    'branch/b',
    { kind: 'branch', title: '#4', headBranch: 'b', pr: 4, headRepo: 'o/r' },
    siteRun(3),
  );
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

test('renderLanding lists branch channels with their branch, newest pull first, beside legacy pr channels', () => {
  let ix = placeRun(empty(), 'pr/12', { kind: 'pr', title: '#12 Legacy', headBranch: 'old' }, siteRun(1));
  ix = placeRun(
    ix,
    'branch/feat-x',
    { kind: 'branch', title: '#20 Feature', headBranch: 'feat/x', pr: 20, headRepo: 'o/r' },
    siteRun(2, { conclusion: 'failure' }),
  );
  ix = placeRun(
    ix,
    'branch/f--y',
    { kind: 'branch', title: '#15 Fork', headBranch: 'y', pr: 15, headRepo: 'f/r' },
    siteRun(3),
  );
  const html = renderLanding(ix, 'o/r');
  expect(html).toContain('<a href="branch/feat-x/">#20 Feature</a>');
  expect(html).toContain('feat/x');
  expect(html).toContain('failure');
  expect(html).toContain('f:y');
  expect(html).toContain('href="pr/12/"');
  const order = ['branch/feat-x/', 'branch/f--y/', 'pr/12/'].map((h) => html.indexOf(`href="${h}"`));
  expect(order).toEqual([...order].sort((a, b) => a - b));
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
  // `pr/` holds the pull request channels, so a workflow named PR gets another folder.
  expect(slug('PR')).toBe('pr--workflow');
  expect(slug(' pr ')).toBe('pr--workflow');
  expect(slug('PR')).not.toBe(slug('PR workflow'));
  expect(slug('PR workflow')).toBe('pr-workflow');
  expect(slug('pr checks')).toBe('pr-checks');
  // `branch/` holds the branch channels, likewise.
  expect(slug('Branch')).toBe('branch--workflow');
  expect(slug('branch builds')).toBe('branch-builds');
  // no slug has `--`, so the reserved keys and fork keys cannot be produced by a name
  expect(slug('a--b')).toBe('a-b');
  expect(reportUrl('https://o.github.io/r', 'ci/runs/1')).toBe('https://o.github.io/r/ci/runs/1/');
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
