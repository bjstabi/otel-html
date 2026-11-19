import { expect, test } from 'vitest';
import type { ApiPull, ApiRun } from '../../../src/cli/ci/github-api.js';
import {
  applyTiers,
  badgeFor,
  type Channel,
  channelBadges,
  channelFor,
  closePullRequest,
  dropWorkflowChannels,
  formatRunDuration,
  parseSiteIndex,
  placeRun,
  pullsOfRun,
  pullsToLink,
  renderLanding,
  reopenPullRequest,
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
  display_title: 't',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-01-01T00:00:00Z',
  run_started_at: null,
  updated_at: '2026-01-01T00:01:00Z',
  html_url: 'https://github.com/o/r/actions/runs/1',
  path: '.github/workflows/ci.yml',
  actor: { type: 'User' },
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

test('placeRun keeps the closedAt of the channel it replaces when the new metadata has none', () => {
  const closed = {
    ...empty(),
    channels: { 'pr/12': { kind: 'pr' as const, title: '#12', headBranch: 'f', closedAt: 'T', runs: [] } },
  };
  const after = placeRun(closed, 'pr/12', { kind: 'pr', title: '#12 x', headBranch: 'f' }, siteRun(1));
  expect(after.channels['pr/12']).toMatchObject({ closedAt: 'T', title: '#12 x' });
});

test('placeRun creates a channel that was removed meanwhile, without mutating the input', () => {
  const before = empty();
  const after = placeRun(before, 'pr/12', { kind: 'pr', title: '#12 x', headBranch: 'feat' }, siteRun(1));
  expect(Object.keys(before.channels)).toEqual([]);
  expect(after.channels['pr/12']?.runs).toHaveLength(1);
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

test('parseSiteIndex skips a channel of an unknown kind, or one it cannot read, with a warning', () => {
  const good = { kind: 'pr', title: '#3', headBranch: 'b', runs: [siteRun(1)] };
  const text = JSON.stringify({
    version: 1,
    channels: {
      'pr/3': good,
      'tag/v1': { kind: 'tag', title: 'v1', headBranch: 'v1', runs: [] },
      'pr/4': { kind: 'pr', title: '#4' },
    },
  });
  const warnings: string[] = [];
  const ix = parseSiteIndex(text, (m) => warnings.push(m));
  expect(Object.keys(ix.channels)).toEqual(['pr/3']);
  expect(ix.channels['pr/3']?.runs).toHaveLength(1);
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain('tag/v1');
  expect(warnings[0]).toContain('kind tag');
  expect(warnings[1]).toContain('pr/4');
  // without a warn callback it still reads; a wrong version or shape still throws
  expect(Object.keys(parseSiteIndex(text).channels)).toEqual(['pr/3']);
  expect(() => parseSiteIndex(JSON.stringify({ version: 2, channels: {} }))).toThrow();
  expect(() => parseSiteIndex(JSON.stringify({ version: 1, channels: [] }))).toThrow();
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
  const order = ['branch/main/', 'f:y', '#12'].map((h) => html.indexOf(h));
  expect(order.every((i) => i > 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test('slug', () => {
  expect(slug('ci')).toBe('ci');
  expect(slug('Perf / Load')).toBe('perf-load');
  expect(slug('feat/Big Thing')).toBe('feat-big-thing');
  expect(slug('pr')).toBe('pr');
  expect(slug('--')).toBe('workflow');
});

test('formatRunDuration: seconds, minutes and hours, never negative', () => {
  expect(formatRunDuration(52_000)).toBe('52s');
  expect(formatRunDuration(252_000)).toBe('4m12s');
  expect(formatRunDuration(3_780_000)).toBe('1h03m');
  expect(formatRunDuration(0)).toBe('0s');
  expect(formatRunDuration(-5_000)).toBe('0s');
});

const timed = (over: Partial<SiteRun> = {}): SiteRun =>
  siteRun(1, {
    workflow: 'ci',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:04:12Z',
    ...over,
  });

test('badgeFor: the conclusion picks the mark and color, the run its duration', () => {
  expect(badgeFor(timed())).toEqual({
    schemaVersion: 1,
    label: 'ci report',
    message: '✓ 4m12s',
    color: 'brightgreen',
  });
  for (const conclusion of ['failure', 'timed_out', 'startup_failure']) {
    expect(badgeFor(timed({ conclusion }))).toMatchObject({ message: '✗ 4m12s', color: 'red' });
  }
  expect(badgeFor(timed({ conclusion: 'cancelled' }))).toMatchObject({
    message: 'cancelled 4m12s',
    color: 'lightgrey',
  });
  expect(badgeFor(timed({ conclusion: 'neutral' }))).toMatchObject({
    message: 'neutral 4m12s',
    color: 'lightgrey',
  });
  expect(badgeFor(siteRun(1, { workflow: 'ci' })).message).toBe('✓');
});

test('channelBadges: one badge file per workflow, from its newest run; runs without a workflow are skipped', () => {
  const channel = {
    ...main,
    runs: [
      timed({ runId: 4 }),
      timed({ runId: 3, workflow: 'load', conclusion: 'failure' }),
      timed({ runId: 2, conclusion: 'failure' }),
      siteRun(1),
    ],
  };
  const badges = channelBadges(channel);
  expect(Object.keys(badges).sort()).toEqual(['badge-ci.json', 'badge-load.json']);
  expect(badges['badge-ci.json']?.message).toBe('✓ 4m12s');
  expect(badges['badge-load.json']?.message).toBe('✗ 4m12s');
});

test('parseSiteIndex round-trips a run with and without startedAt', () => {
  const index: SiteIndex = {
    version: 1,
    channels: { [MAIN]: { ...main, runs: [timed({ runId: 2 }), siteRun(1)] } },
  };
  expect(parseSiteIndex(JSON.stringify(index))).toEqual(index);
});

test('channelBadges skips in-progress runs: the badge names the newest finished run (D66)', () => {
  const channel = {
    ...main,
    runs: [
      timed({ runId: 4, conclusion: 'in_progress' }),
      timed({ runId: 3, conclusion: 'failure' }),
      timed({ runId: 2 }),
    ],
  };
  expect(channelBadges(channel)['badge-ci.json']?.message).toBe('✗ 4m12s');
  expect(channelBadges({ ...main, runs: [timed({ runId: 4, conclusion: 'in_progress' })] })).toEqual({});
});

const chan = (kind: 'branch' | 'pr', runs: SiteRun[], over: Partial<Channel> = {}): Channel => ({
  kind,
  title: kind === 'pr' ? '#1 t' : 'main',
  headBranch: kind === 'pr' ? 'feat' : 'main',
  runs,
  ...over,
});
const at = (id: number, over: Partial<SiteRun> = {}): SiteRun =>
  siteRun(id, { completedAt: `2026-01-${String(id).padStart(2, '0')}T00:00:00Z`, workflow: 'ci', ...over });
const newestFirst = (...ids: number[]): number[] => ids;
const ids = (c: Channel | undefined): number[] => (c?.runs ?? []).map((r) => r.runId);
const TIERS = { full: 2, slim: 4, prFull: 1, prSlim: 10 };

test('applyTiers on a branch channel: full, then slim, then dropped, per workflow', () => {
  const ci = [6, 5, 4, 3, 2, 1].map((i) => at(i));
  const load = [8, 7].map((i) => at(i, { workflow: 'load' }));
  const ix: SiteIndex = { version: 1, channels: { [MAIN]: chan('branch', [...load, ...ci]) } };
  const r = applyTiers(ix, TIERS);
  const out = r.index.channels[MAIN]?.runs ?? [];
  const detail = (id: number) => out.find((x) => x.runId === id)?.detail;
  expect([6, 5].map(detail)).toEqual(['full', 'full']);
  expect([4, 3].map(detail)).toEqual(['slim', 'slim']);
  expect([8, 7].map(detail)).toEqual(['full', 'full']);
  expect(r.trim.map((t) => t.run.runId).sort()).toEqual([3, 4]);
  expect(r.drop.map((t) => t.run.runId).sort()).toEqual([1, 2]);
  expect(r.drop.every((t) => t.key === MAIN)).toBe(true);
  expect(ids(r.index.channels[MAIN]).sort()).toEqual([3, 4, 5, 6, 7, 8]);
});

test('applyTiers keeps a slim run slim when it ranks among the full', () => {
  const ix: SiteIndex = {
    version: 1,
    channels: { [MAIN]: chan('branch', [at(2, { detail: 'slim' }), at(1)]) },
  };
  const r = applyTiers(ix, TIERS);
  expect(r.index.channels[MAIN]?.runs.map((x) => x.detail)).toEqual(['slim', 'full']);
  expect(r.trim).toEqual([]);
});

test('applyTiers: an open pull request keeps prFull full, the rest slim; a closed one is all slim', () => {
  const ix: SiteIndex = {
    version: 1,
    channels: {
      'pr/1': chan('pr', [at(3), at(2), at(1)]),
      'pr/2': chan('pr', [at(6), at(5)], { closedAt: '2026-02-01T00:00:00Z' }),
    },
  };
  const r = applyTiers(ix, TIERS);
  expect(r.index.channels['pr/1']?.runs.map((x) => x.detail)).toEqual(['full', 'slim', 'slim']);
  expect(r.index.channels['pr/2']?.runs.map((x) => x.detail)).toEqual(['slim', 'slim']);
  expect(r.trim.map((t) => t.run.runId).sort()).toEqual([1, 2, 5, 6]);
});

test('applyTiers: the pull request pool keeps prSlim slim runs per workflow across channels and removes emptied channels', () => {
  const ix: SiteIndex = {
    version: 1,
    channels: {
      'pr/1': chan('pr', [at(3), at(2), at(1)], { closedAt: '2026-02-01T00:00:00Z' }),
      'pr/2': chan('pr', [at(5), at(4)]),
    },
  };
  const r = applyTiers(ix, { ...TIERS, prSlim: 2 });
  // slim PR runs: 3,2,1 (pr/1) and 4 (pr/2); run 5 is full; the newest two slim are 4 and 3
  expect(r.drop.map((t) => t.run.runId).sort()).toEqual([1, 2]);
  expect(ids(r.index.channels['pr/1'])).toEqual([3]);
  expect(ids(r.index.channels['pr/2'])).toEqual([5, 4]);
  const gone = applyTiers(
    {
      version: 1,
      channels: { 'pr/1': chan('pr', [at(1)], { closedAt: 'x' }), 'pr/2': chan('pr', [at(9), at(8)]) },
    },
    { ...TIERS, prSlim: 1 },
  );
  expect(gone.drop.map((t) => t.run.runId)).toEqual([1]);
  expect(Object.keys(gone.index.channels)).toEqual(['pr/2']);
});

test('applyTiers never drops the publishing run and leaves its detail', () => {
  const ci = [6, 5, 4, 3, 2, 1].map((i) => at(i));
  const ix: SiteIndex = { version: 1, channels: { [MAIN]: chan('branch', ci) } };
  const r = applyTiers(ix, TIERS, new Set([1, 6]));
  const out = r.index.channels[MAIN]?.runs ?? [];
  expect(out.find((x) => x.runId === 1)?.detail).toBe('full');
  expect(r.drop.map((t) => t.run.runId)).toEqual([2]);
  expect(r.trim.map((t) => t.run.runId).sort()).toEqual([3, 4]);
  const pr = applyTiers(
    { version: 1, channels: { 'pr/1': chan('pr', [at(3), at(2), at(1)], { closedAt: 'x' }) } },
    { ...TIERS, prSlim: 1 },
    new Set([1]),
  );
  expect(ids(pr.index.channels['pr/1'])).toEqual([3, 1]);
  expect(newestFirst(...pr.drop.map((t) => t.run.runId))).toEqual([2]);
});

test('closePullRequest marks closedAt once; reopenPullRequest clears it; an unknown channel is unchanged', () => {
  const ix: SiteIndex = { version: 1, channels: { 'pr/1': chan('pr', [at(1)]) } };
  const closed = closePullRequest(ix, 1, '2026-02-01T00:00:00Z');
  expect(closed.changed).toBe(true);
  expect(closed.index.channels['pr/1']?.closedAt).toBe('2026-02-01T00:00:00Z');
  const again = closePullRequest(closed.index, 1, '2026-03-01T00:00:00Z');
  expect(again.changed).toBe(false);
  expect(again.index.channels['pr/1']?.closedAt).toBe('2026-02-01T00:00:00Z');
  const reopened = reopenPullRequest(closed.index, 1);
  expect(reopened.changed).toBe(true);
  expect('closedAt' in (reopened.index.channels['pr/1'] ?? {})).toBe(false);
  expect(reopenPullRequest(reopened.index, 1).changed).toBe(false);
  expect(closePullRequest(ix, 9, 'x')).toEqual({ index: ix, changed: false });
  expect(reopenPullRequest(ix, 9)).toEqual({ index: ix, changed: false });
});

test('renderLanding links open pull requests into the branch report with their branch selected, and skips closed ones', () => {
  let ix = placeRun(empty(), MAIN, main, siteRun(1));
  ix = placeRun(ix, 'pr/12', { kind: 'pr', title: '#12 Open', headBranch: 'feat-open' }, siteRun(2));
  ix = placeRun(
    ix,
    'pr/13',
    { kind: 'pr', title: '#13 Shut', headBranch: 'feat-shut', closedAt: '2026-02-01T00:00:00Z' },
    siteRun(3),
  );
  const html = renderLanding(ix, 'o/r', { dashboard: 'ci' });
  expect(html).toContain('href="branch/main/#/dashboards/ci?');
  expect(html).toContain('vcs.ref.head.name');
  expect(html).toContain('feat-open');
  expect(html).not.toContain('#13');
  expect(html).not.toContain('feat-shut');
  expect(renderLanding(ix, 'o/r')).toContain('href="branch/main/"');
  const noBranch = renderLanding(
    placeRun(empty(), 'pr/12', { kind: 'pr', title: '#12 Open', headBranch: 'f' }, siteRun(2)),
    'o/r',
    { dashboard: 'ci' },
  );
  expect(noBranch).not.toContain('Pull requests');
});

test('siteIndexSchema round-trips detail, reportUrl and closedAt, and still reads an index without them', () => {
  const ix: SiteIndex = {
    version: 1,
    channels: {
      'pr/1': chan('pr', [at(1, { detail: 'slim', reportUrl: 'https://x/y/' })], {
        closedAt: '2026-02-01T00:00:00Z',
      }),
    },
  };
  expect(siteIndexSchema.parse(JSON.parse(JSON.stringify(ix)))).toEqual(ix);
  const plain: SiteIndex = { version: 1, channels: { [MAIN]: chan('branch', [at(1)]) } };
  expect(siteIndexSchema.parse(JSON.parse(JSON.stringify(plain)))).toEqual(plain);
});

test('applyTiers: a run shared by two pull request channels is dropped only from the copy past prSlim', () => {
  const closed = { closedAt: '2026-02-01T00:00:00Z' };
  const ix: SiteIndex = {
    version: 1,
    channels: {
      'pr/1': chan('pr', [at(9)], closed),
      'pr/2': chan('pr', [at(9)], closed),
    },
  };
  const r = applyTiers(ix, { ...TIERS, prSlim: 1 });
  expect(r.drop.map((t) => `${t.key}:${t.run.runId}`)).toEqual(['pr/2:9']);
  expect(ids(r.index.channels['pr/1'])).toEqual([9]);
  expect(r.index.channels['pr/1']?.runs[0]?.detail).toBe('slim');
  expect(r.index.channels['pr/2']).toBeUndefined();
});
