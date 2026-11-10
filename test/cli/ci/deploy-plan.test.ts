import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runDeployPlan } from '../../../src/cli/ci/deploy-main.js';
import { type PendingPlan, type PlanOptions, planDeploy } from '../../../src/cli/ci/deploy-plan.js';
import { emptyState, type SiteState, writeSiteState } from '../../../src/cli/ci/site-state.js';
import type { CliIo } from '../../../src/cli/io.js';
import { createMemoryFileSystem } from '../../../test-support/memory-fs.js';
import { buildZip } from '../../../test-support/zip.js';

const API = 'https://api.test';
const R = `${API}/repos/o/r`;
const PAGES = 'https://o.github.io/r';
const NOW = '2026-11-10T12:00:00Z';

type Route = () => Response | Promise<Response>;

/** A fake GitHub keyed by URL: an unrouted URL fails the test by throwing. */
function fake(routes: Record<string, Route>): {
  fetchFn: (url: string) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetchFn: async (url: string) => {
      calls.push(url);
      const route = routes[url];
      if (route === undefined) throw new Error(`unexpected request: ${url}`);
      return route();
    },
  };
}

const json =
  (body: unknown, headers: Record<string, string> = {}): Route =>
  () =>
    Response.json(body, { headers });
const missing: Route = () => new Response('{}', { status: 404 });

/** The files of a state as an artifact body: the five files at the zip root. */
async function stateZip(state: SiteState): Promise<Uint8Array> {
  const fs = createMemoryFileSystem();
  await writeSiteState(fs, '/s', state);
  return buildZip([...fs.snapshot()].map(([path, data]) => ({ name: path.slice('/s/'.length), data })));
}
const zipRoute =
  (bytes: Uint8Array): Route =>
  () =>
    new Response(bytes);

const stateWith = (
  form: SiteState['applied']['form'],
  updates: string[],
  extra?: Partial<SiteState>,
): SiteState => {
  const s = emptyState(NOW);
  s.applied = {
    ...s.applied,
    form,
    floor: '2026-11-10T10:00:00Z',
    updates: Object.fromEntries(
      updates.map((id) => [id, { outcome: 'applied' as const, createdAt: '2026-11-10T10:30:00Z', pass: 11 }]),
    ),
  };
  return { ...s, ...extra };
};

const art = (id: number, name: string, createdAt: string, run: number) => ({
  id,
  name,
  size_in_bytes: 1000,
  created_at: createdAt,
  expires_at: '2027-01-01T00:00:00Z',
  workflow_run: { id: run },
});

const apiRun = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  run_attempt: 1,
  name: 'ci',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-10T11:00:00Z',
  run_started_at: '2026-11-10T11:00:00Z',
  updated_at: '2026-11-10T11:10:00Z',
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  path: '.github/workflows/ci.yml',
  actor: { type: 'User' },
  head_branch: 'main',
  head_sha: `sha${id}`,
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
  head_repository: { full_name: 'o/r' },
  ...over,
});

const opts = (over: Partial<PlanOptions> = {}): PlanOptions => ({
  apiUrl: API,
  repository: 'o/r',
  ciWorkflows: ['ci.yml'],
  reportWorkflow: 'ci-report.yml',
  deployerWorkflow: 'pages-deploy.yml',
  pagesUrl: PAGES,
  stateOut: '/out/state',
  now: NOW,
  ...over,
});

const deployments = (
  ...rows: { id: number; created: string; success: boolean; run?: number }[]
): Record<string, Route> =>
  Object.assign(
    {
      [`${R}/deployments?environment=github-pages&per_page=100`]: json(
        rows.map((d) => ({ id: d.id, created_at: d.created, environment: 'github-pages' })),
      ),
    },
    ...rows.map((d) => ({
      [`${R}/deployments/${d.id}/statuses?per_page=100`]: json(
        d.success
          ? [
              {
                state: 'success',
                log_url: `https://github.com/o/r/actions/runs/${d.run}/jobs/1`,
                created_at: d.created,
              },
              { state: 'in_progress', log_url: '', created_at: d.created },
            ]
          : [{ state: 'in_progress', log_url: '', created_at: d.created }],
      ),
    })),
  );

const listing = (items: unknown[], link?: string): Route => json({ artifacts: items }, link ? { link } : {});

const deployerRun = (id: number, over: Record<string, unknown> = {}) =>
  apiRun(id, {
    name: 'pages-deploy',
    path: '.github/workflows/pages-deploy.yml',
    event: 'workflow_dispatch',
    ...over,
  });

/** The repository of the brief's main scenario. */
async function world(): Promise<Record<string, Route>> {
  const base = stateWith({ kind: 'full', runId: 11 }, ['900']);
  const consumed = stateWith({ kind: 'consumed', base: 2000 }, ['900', '901', '902']);
  const pr5 = {
    number: 5,
    title: 'Feat',
    state: 'open',
    head: { sha: 'sha21', ref: 'feat', repo: { full_name: 'o/r' } },
  };
  return {
    [R]: json({ default_branch: 'main' }),
    ...deployments(
      { id: 2001, created: '2026-11-10T11:55:00Z', success: false },
      { id: 2000, created: '2026-11-10T11:05:00Z', success: true, run: 11 },
    ),
    [`${R}/actions/runs/11/artifacts?name=github-pages`]: json({
      artifacts: [art(100, 'github-pages', '2026-11-10T11:05:00Z', 11)],
    }),
    [`${R}/actions/runs/11/artifacts?name=otel-html-site-state-11`]: json({
      artifacts: [art(101, 'otel-html-site-state-11', '2026-11-10T11:06:00Z', 11)],
    }),
    [`${R}/actions/artifacts/101/zip`]: zipRoute(await stateZip(base)),
    [`${R}/actions/artifacts/102/zip`]: zipRoute(await stateZip(consumed)),
    [`${R}/actions/artifacts?per_page=100`]: listing(
      [
        art(102, 'otel-html-site-state-base-2000', '2026-11-10T11:50:00Z', 50),
        art(103, 'otel-html-update-push-7-1', '2026-11-10T11:49:00Z', 21),
        art(104, 'otel-html-update-push-9-1', '2026-11-10T11:48:00Z', 21),
        art(105, 'otel-html-update-push-h0123456789ab-1', '2026-11-10T11:47:00Z', 21),
        art(106, 'otel-html-update-run-22-1', '2026-11-10T11:46:00Z', 30),
        art(107, 'otel-html-update-run-22-2', '2026-11-10T11:45:00Z', 31),
        art(108, 'otel-html-update-run-23-1', '2026-11-10T11:44:00Z', 23),
        art(109, 'otel-html-update-push-8-1', '2026-11-10T11:43:00Z', 40),
        art(110, 'otel-html-update-remove-pr-5-24', '2026-11-10T11:42:00Z', 24),
        art(111, 'ci-run-report', '2026-11-10T11:41:00Z', 25),
        art(902, 'otel-html-update-push-1-1', '2026-11-10T11:40:00Z', 21),
        art(112, 'otel-html-update-push-3-1', '2026-11-10T09:00:00Z', 21),
      ],
      `<${R}/actions/artifacts?per_page=100&page=2>; rel="next"`,
    ),
    [`${R}/actions/runs/50`]: json(deployerRun(50)),
    [`${R}/actions/runs/21`]: json(
      apiRun(21, { event: 'pull_request', head_branch: 'feat', head_sha: 'sha21' }),
    ),
    [`${R}/commits/sha21/pulls?per_page=100`]: json([pr5]),
    [`${R}/actions/runs/21/attempts/1/jobs?per_page=100`]: json({
      jobs: [{ id: 7, name: 'check', steps: [] }],
    }),
    [`${R}/actions/runs/22`]: json(apiRun(22)),
    [`${R}/commits/sha22/pulls?per_page=100`]: json([]),
    [`${R}/actions/runs/30`]: json(
      apiRun(30, { name: 'ci-report', path: '.github/workflows/ci-report.yml', event: 'workflow_run' }),
    ),
    [`${R}/actions/runs/31`]: json(
      apiRun(31, {
        name: 'ci-report',
        path: '.github/workflows/ci-report.yml',
        event: 'workflow_run',
        head_branch: 'feat',
      }),
    ),
    [`${R}/actions/runs/23`]: json(apiRun(23)),
    [`${R}/actions/runs/40`]: json(apiRun(40, { event: 'pull_request_target' })),
    [`${R}/actions/runs/24`]: json(
      apiRun(24, {
        name: 'ci-report',
        path: '.github/workflows/ci-report.yml',
        event: 'pull_request_target',
        head_branch: 'feat',
      }),
    ),
    [`${R}/pulls/5`]: json(pull5()),
  };
}

const pull5 = (over: Record<string, unknown> = {}) => ({
  number: 5,
  title: 'Feat',
  state: 'open',
  base: { ref: 'main' },
  head: { sha: 'sha21', ref: 'feat', repo: { full_name: 'o/r' } },
  ...over,
});

describe('planDeploy', () => {
  test('finds the base, the newest state and the authenticated pending updates', async () => {
    const { fetchFn, calls } = fake(await world());
    const fs = createMemoryFileSystem();
    const plan = await planDeploy(opts(), { fs }, 'tok', fetchFn);

    expect(plan.base).toEqual({
      kind: 'artifact',
      deploymentId: 2000,
      runId: 11,
      artifactId: 100,
      liveAt: '2026-11-10T11:05:00Z',
    });
    expect(plan.state).toEqual({ kind: 'consumed', base: 2000 });
    expect(plan.floor).toBe('2026-11-10T10:42:00.000Z');
    expect(plan.deletionsDue).toBe(0);
    expect(plan.version).toBe(1);

    const byId = new Map(plan.updates.map((u) => [u.id, u]));
    // the consumed one (902), the state artifact, ci-run-report and the one past the floor are not candidates
    expect([...byId.keys()]).toEqual([103, 104, 105, 106, 107, 108, 109, 110]);
    expect(byId.get(103)).toMatchObject({
      name: 'otel-html-update-push-7-1',
      parsed: { kind: 'push', jobKey: '7', sequence: 1 },
      uploader: {
        runId: 21,
        path: '.github/workflows/ci.yml',
        event: 'pull_request',
        headBranch: 'feat',
        sameRepo: true,
      },
      run: { runId: 21, event: 'pull_request', reportPath: 'pr/5/runs/21' },
      channel: {
        key: 'pr/5',
        channel: { kind: 'pr', title: '#5 Feat', headBranch: 'feat', headRepo: 'o/r' },
      },
      jobName: 'check',
      accepted: true,
    });
    expect(byId.get(104)).toMatchObject({ accepted: false, reason: 'not a job of run 21 attempt 1' });
    expect(byId.get(105)).toMatchObject({ accepted: true, channel: { key: 'pr/5' } });
    expect(byId.get(105)?.jobName).toBeUndefined();
    expect(byId.get(106)).toMatchObject({
      accepted: true,
      uploader: { runId: 30, event: 'workflow_run', headBranch: 'main' },
      run: { runId: 22, event: 'push', conclusion: 'success', reportPath: 'branch/main/runs/22' },
      channel: { key: 'branch/main' },
    });
    expect(byId.get(107)).toMatchObject({ accepted: false, reason: 'not the default branch' });
    expect(byId.get(108)).toMatchObject({ accepted: false, reason: 'not the report workflow' });
    expect(byId.get(109)).toMatchObject({ accepted: false });
    expect(byId.get(109)?.reason).toContain('pull_request_target');
    expect(byId.get(110)).toMatchObject({
      accepted: true,
      parsed: { kind: 'remove-pr', pr: 5, runId: 24 },
      channel: null,
    });

    // the chosen state, the consumed-only one, was written; update artifacts and page 2 were never requested
    const written = await fs.readText('/out/state/applied.json');
    expect(Object.keys(JSON.parse(written).updates)).toEqual(['900', '901', '902']);
    expect(calls.some((c) => /\/artifacts\/10[3-9]\/zip|page=2/.test(c))).toBe(false);
  });

  test('a push whose uploader is a fork pull request is marked not same-repo and still takes the pull request channel', async () => {
    const routes = await world();
    routes[`${R}/actions/runs/21`] = json(
      apiRun(21, {
        event: 'pull_request',
        head_branch: 'feat',
        head_sha: 'sha21',
        head_repository: { full_name: 'fork/r' },
      }),
    );
    routes[`${R}/commits/sha21/pulls?per_page=100`] = json([
      {
        number: 5,
        title: 'Feat',
        state: 'open',
        head: { sha: 'sha21', ref: 'feat', repo: { full_name: 'fork/r' } },
      },
    ]);
    const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
    expect(plan.updates.find((u) => u.id === 103)).toMatchObject({
      accepted: true,
      uploader: { sameRepo: false },
      channel: { key: 'pr/5' },
    });
  });

  test('a push with no open pull request and off the default branch has no channel and is rejected', async () => {
    const routes = await world();
    routes[`${R}/commits/sha21/pulls?per_page=100`] = json([]);
    const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
    expect(plan.updates.find((u) => u.id === 103)).toMatchObject({
      accepted: false,
      reason: 'no channel',
      channel: null,
    });
  });

  test('an update over the size limit is rejected without being downloaded', async () => {
    const routes = await world();
    const page = (await (routes[`${R}/actions/artifacts?per_page=100`] as Route)()).clone();
    const body = (await page.json()) as { artifacts: { id: number; size_in_bytes: number }[] };
    const big = body.artifacts.map((a) => (a.id === 103 ? { ...a, size_in_bytes: 300 * 1024 * 1024 } : a));
    routes[`${R}/actions/artifacts?per_page=100`] = listing(big);
    const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
    expect(plan.updates.find((u) => u.id === 103)).toMatchObject({ accepted: false, reason: 'too large' });
  });

  test('a remove-pr is vouched for by its pull request, not by the uploader branch', async () => {
    const reasonFor = async (routes: Record<string, Route>): Promise<string | undefined> =>
      (await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn)).updates.find(
        (u) => u.id === 110,
      )?.reason;
    const wrongBase = await world();
    wrongBase[`${R}/pulls/5`] = json(pull5({ base: { ref: 'release' } }));
    expect(await reasonFor(wrongBase)).toBe("not the pull request's run");
    const wrongHead = await world();
    wrongHead[`${R}/pulls/5`] = json(pull5({ head: { sha: 'x', ref: 'other', repo: { full_name: 'o/r' } } }));
    expect(await reasonFor(wrongHead)).toBe("not the pull request's run");
    const wrongRepo = await world();
    wrongRepo[`${R}/pulls/5`] = json(
      pull5({ head: { sha: 'x', ref: 'feat', repo: { full_name: 'fork/r' } } }),
    );
    expect(await reasonFor(wrongRepo)).toBe("not the pull request's run");
    const gone = await world();
    gone[`${R}/pulls/5`] = missing;
    expect(await reasonFor(gone)).toBe('pull request 5 not found');
    const broken = await world();
    broken[`${R}/pulls/5`] = () => new Response('', { status: 500 });
    await expect(
      planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(broken).fetchFn),
    ).rejects.toThrow(/500/);
  });

  test('a transient failure downloading the newest consumed state fails the pass; unreadable content is skipped', async () => {
    const routes = await world();
    routes[`${R}/actions/artifacts/102/zip`] = () => new Response('', { status: 503 });
    await expect(
      planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn),
    ).rejects.toThrow(/503/);
    routes[`${R}/actions/artifacts/102/zip`] = () => new Response('not a zip');
    const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
    expect(plan.state).toEqual({ kind: 'full', runId: 11 });
  });

  test('a consumed state uploaded by a ci.yml pull_request run is ignored, never downloaded', async () => {
    const routes = await world();
    routes[`${R}/actions/runs/50`] = json(
      apiRun(50, { event: 'pull_request', head_branch: 'feat', head_repository: { full_name: 'fork/r' } }),
    );
    const { fetchFn, calls } = fake(routes);
    const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fetchFn);
    expect(plan.state).toEqual({ kind: 'full', runId: 11 });
    expect(calls.some((c) => c.endsWith('/artifacts/102/zip'))).toBe(false);
  });

  test.each([
    ['a different workflow', { path: '.github/workflows/ci.yml' }],
    ['another repository', { head_repository: { full_name: 'fork/r' } }],
    ['a branch that is not the default', { head_branch: 'feat' }],
    ['a pull_request event', { event: 'pull_request' }],
    ['a run older than the base', { id: 10 }],
  ])('a consumed state uploaded by %s is ignored', async (_n, over) => {
    const routes = await world();
    routes[`${R}/actions/runs/50`] = json(deployerRun(50, over));
    const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
    expect(plan.state).toEqual({ kind: 'full', runId: 11 });
  });

  test('a consumed state from the deployer workflow on the default branch is used (any allowed event)', async () => {
    for (const event of ['workflow_dispatch', 'schedule', 'workflow_run']) {
      const routes = await world();
      routes[`${R}/actions/runs/50`] = json(deployerRun(50, { event }));
      const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
      expect(plan.state).toEqual({ kind: 'consumed', base: 2000 });
    }
  });

  test('a run lookup failing with a non-404 error while authenticating a state fails the pass', async () => {
    const routes = await world();
    routes[`${R}/actions/runs/50`] = () => new Response('', { status: 503 });
    await expect(
      planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn),
    ).rejects.toThrow(/503/);
  });

  test('an update below the chosen state floor is not a candidate even when its pruned updates lack it', async () => {
    const routes = await world();
    const base = stateWith({ kind: 'full', runId: 11 }, ['104']);
    const consumed = stateWith({ kind: 'consumed', base: 2000 }, ['900']);
    consumed.applied.floor = '2026-11-10T11:48:30Z';
    routes[`${R}/actions/artifacts/101/zip`] = zipRoute(await stateZip(base));
    routes[`${R}/actions/artifacts/102/zip`] = zipRoute(await stateZip(consumed));
    const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
    expect(plan.state).toEqual({ kind: 'consumed', base: 2000 });
    const ids = plan.updates.map((u) => u.id);
    expect(ids).toContain(103);
    expect(ids).not.toContain(104);
    expect(ids).not.toContain(105);
  });

  test('a run that cannot be found rejects its updates; another API failure fails the pass', async () => {
    const routes = await world();
    routes[`${R}/actions/runs/30`] = missing;
    const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
    expect(plan.updates.find((u) => u.id === 106)).toMatchObject({
      accepted: false,
      reason: 'run 30 not found',
    });
    routes[`${R}/actions/runs/30`] = () => new Response('', { status: 503 });
    await expect(
      planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn),
    ).rejects.toThrow(/503/);
  });

  test('with no deployed state artifact the live applied.json gives the consumed ids and the floor', async () => {
    const routes = await world();
    routes[`${R}/actions/runs/11/artifacts?name=otel-html-site-state-11`] = json({ artifacts: [] });
    delete routes[`${R}/actions/artifacts/101/zip`];
    routes[`${R}/actions/artifacts?per_page=100`] = listing([
      art(103, 'otel-html-update-push-7-1', '2026-11-10T11:49:00Z', 21),
      art(105, 'otel-html-update-push-h0123456789ab-1', '2026-11-10T11:47:00Z', 21),
    ]);
    routes[`${PAGES}/site-state/applied.json`] = json(
      JSON.parse(await stateZipApplied(stateWith({ kind: 'full', runId: 11 }, ['105']))),
    );
    for (const n of ['removed', 'files', 'deletions', 'runs'])
      routes[`${PAGES}/site-state/${n}.json`] = missing;
    const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
    expect(plan.state).toEqual({ kind: 'full', runId: 11 });
    expect(plan.updates.map((u) => u.id)).toEqual([103]);
  });

  test('a cold start takes the live site-state files as the state', async () => {
    const routes = await world();
    routes[`${R}/actions/runs/11/artifacts?name=otel-html-site-state-11`] = json({ artifacts: [] });
    delete routes[`${R}/actions/artifacts/101/zip`];
    routes[`${R}/actions/artifacts?per_page=100`] = listing([]);
    const live = stateWith({ kind: 'full', runId: 11 }, ['105'], {
      deletions: { version: 1, files: [{ path: 'old/x.txt', pass: 5, liveAt: '2026-11-10T09:00:00Z' }] },
      runs: { version: 1, runs: { 'branch/main/runs/3': { next: 2, attempt: 1, jobs: {} } } },
    });
    for (const n of ['applied', 'removed', 'files', 'deletions', 'runs'] as const)
      routes[`${PAGES}/site-state/${n}.json`] = json(live[n]);
    const fs = createMemoryFileSystem();
    const plan = await planDeploy(opts(), { fs }, 'tok', fake(routes).fetchFn);
    expect(plan.state).toEqual({ kind: 'full', runId: 11 });
    expect(plan.deletionsDue).toBe(1);
    expect(await fs.readText('/out/state/deletions.json')).toContain('old/x.txt');
    expect(await fs.readText('/out/state/runs.json')).toContain('branch/main/runs/3');
  });

  test('a missing live applied.json means everything pending, with the floor an hour back', async () => {
    const routes = await world();
    routes[`${R}/actions/runs/11/artifacts?name=otel-html-site-state-11`] = json({ artifacts: [] });
    routes[`${PAGES}/site-state/applied.json`] = missing;
    routes[`${R}/actions/artifacts?per_page=100`] = listing([
      art(103, 'otel-html-update-push-7-1', '2026-11-10T11:49:00Z', 21),
      art(113, 'otel-html-update-push-7-2', '2026-11-10T10:30:00Z', 21),
      art(114, 'otel-html-update-push-7-3', '2026-11-10T10:59:00Z', 21),
    ]);
    const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
    // 10:30 is older than now - 1 h = 11:00: the walk stopped there
    expect(plan.updates.map((u) => u.id)).toEqual([103]);
    expect(plan.floor).toBe('2026-11-10T10:49:00.000Z');
  });

  test('no pending candidate puts the floor an hour before now', async () => {
    const routes = await world();
    routes[`${R}/actions/artifacts?per_page=100`] = listing([]);
    const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
    expect(plan.updates).toEqual([]);
    expect(plan.floor).toBe('2026-11-10T11:00:00.000Z');
  });

  describe('without a deployed tarball', () => {
    const noSuccess = async (newest: string): Promise<Record<string, Route>> => ({
      [R]: json({ default_branch: 'main' }),
      ...deployments({ id: 2001, created: newest, success: false }),
      [`${R}/actions/artifacts?per_page=100`]: listing([]),
    });

    test('a live site with a young newest deployment waits', async () => {
      const routes = await noSuccess('2026-11-10T11:58:00Z');
      routes[`${PAGES}/site-state/files.json`] = json({ version: 1, files: {} });
      const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
      expect(plan.base.kind).toBe('wait');
    });

    test('a live site with an older newest deployment is the base', async () => {
      const routes = await noSuccess('2026-11-10T11:48:00Z');
      routes[`${PAGES}/site-state/files.json`] = json({ version: 1, files: {} });
      routes[`${PAGES}/site-state/applied.json`] = missing;
      const plan = await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn);
      expect(plan.base).toEqual({ kind: 'live' });
    });

    test('the gh-pages branch is the base when the site has no state', async () => {
      const routes = await noSuccess('2026-11-10T11:48:00Z');
      routes[`${PAGES}/site-state/files.json`] = missing;
      routes[`${PAGES}/site-state/applied.json`] = missing;
      routes[`${R}/branches/gh-pages`] = json({ name: 'gh-pages' });
      expect(
        (await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn)).base.kind,
      ).toBe('gh-pages');
      routes[`${R}/branches/gh-pages`] = missing;
      expect(
        (await planDeploy(opts(), { fs: createMemoryFileSystem() }, 'tok', fake(routes).fetchFn)).base.kind,
      ).toBe('empty');
    });
  });

  test('deletions of the base pass come due fifteen minutes after it went live', async () => {
    const routes = await world();
    const state = stateWith({ kind: 'full', runId: 11 }, [], {
      deletions: {
        version: 1,
        files: [
          { path: 'a', pass: 11 },
          { path: 'b', pass: 10, liveAt: '2026-11-10T11:30:00Z' },
          { path: 'c', pass: 12 },
        ],
      },
    });
    routes[`${R}/actions/artifacts/101/zip`] = zipRoute(await stateZip(state));
    routes[`${R}/actions/artifacts?per_page=100`] = listing([]);
    // the base went live 16 minutes before now
    routes[`${R}/deployments/2000/statuses?per_page=100`] = json([
      {
        state: 'success',
        log_url: 'https://github.com/o/r/actions/runs/11/jobs/1',
        created_at: '2026-11-10T11:44:00Z',
      },
    ]);
    const fs = createMemoryFileSystem();
    const plan = await planDeploy(opts(), { fs }, 'tok', fake(routes).fetchFn);
    expect(plan.deletionsDue).toBe(2);
    const written = JSON.parse(await fs.readText('/out/state/deletions.json')) as {
      files: { path: string; liveAt?: string }[];
    };
    expect(written.files.map((f) => [f.path, f.liveAt])).toEqual([
      ['a', '2026-11-10T11:44:00Z'],
      ['b', '2026-11-10T11:30:00Z'],
      ['c', undefined],
    ]);
  });
});

/** An `applied.json` as the site serves it. */
async function stateZipApplied(state: SiteState): Promise<string> {
  const fs = createMemoryFileSystem();
  await writeSiteState(fs, '/s', state);
  return fs.readText('/s/applied.json');
}

describe('runDeployPlan', () => {
  let dir: string;
  let outputs: string;
  let stdout: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-plan-'));
    outputs = join(dir, 'output');
    stdout = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const io = (): CliIo =>
    ({
      stdout: (s: string) => stdout.push(s),
      stderr: (s: string) => stdout.push(s),
      env: { GITHUB_API_URL: API, GITHUB_TOKEN: 'tok', GITHUB_OUTPUT: outputs },
      cwd: dir,
    }) as unknown as CliIo;

  test('writes pending.json, the state files and the step outputs', async () => {
    const { fetchFn } = fake(await world());
    const fs = createMemoryFileSystem();
    await runDeployPlan(
      {
        repository: 'o/r',
        out: '/out/pending.json',
        stateOut: '/out/state',
        pagesUrl: PAGES,
        ciWorkflows: ['ci.yml'],
        reportWorkflow: 'ci-report.yml',
        deployerWorkflow: 'pages-deploy.yml',
        now: NOW,
      },
      io(),
      { fs },
      fetchFn,
    );
    const plan = JSON.parse(await fs.readText('/out/pending.json')) as PendingPlan;
    expect(plan.updates.filter((u) => u.accepted).map((u) => u.id)).toEqual([103, 105, 106, 110]);
    expect(await fs.exists('/out/state/applied.json')).toBe(true);
    const text = readFileSync(outputs, 'utf8');
    expect(text).toContain('pending=true');
    expect(text).toContain('base_kind=artifact');
    expect(text).toContain('base_run_id=11');
    expect(text).toContain('base_artifact_id=100');
    expect(text).toContain('base_deployment_id=2000');
    expect(text).toContain('wait=false');
  });

  test('an empty site with nothing pending says so and sets pending=false', async () => {
    const { fetchFn } = fake({
      [R]: json({ default_branch: 'main' }),
      ...deployments(),
      [`${PAGES}/site-state/files.json`]: missing,
      [`${PAGES}/site-state/applied.json`]: missing,
      [`${R}/branches/gh-pages`]: missing,
      [`${R}/actions/artifacts?per_page=100`]: listing([]),
    });
    await runDeployPlan(
      {
        repository: 'o/r',
        out: '/out/pending.json',
        stateOut: '/out/state',
        pagesUrl: PAGES,
        ciWorkflows: ['ci.yml'],
        reportWorkflow: 'ci-report.yml',
        deployerWorkflow: 'pages-deploy.yml',
        now: NOW,
      },
      io(),
      { fs: createMemoryFileSystem() },
      fetchFn,
    );
    const text = readFileSync(outputs, 'utf8');
    expect(text).toContain('pending=false');
    expect(text).toContain('base_kind=empty');
    expect(text).toContain('base_run_id=\n');
  });

  test('a rejected update with nothing accepted still sets pending=true: apply records the rejection', async () => {
    const { fetchFn } = fake({
      [R]: json({ default_branch: 'main' }),
      ...deployments(),
      [`${PAGES}/site-state/files.json`]: missing,
      [`${PAGES}/site-state/applied.json`]: missing,
      [`${R}/branches/gh-pages`]: missing,
      [`${R}/actions/artifacts?per_page=100`]: listing([
        art(300, 'otel-html-update-push-7-1', '2026-11-10T11:50:00Z', 70),
      ]),
      [`${R}/actions/runs/70`]: missing,
    });
    const fs = createMemoryFileSystem();
    const plan = await runDeployPlan(
      {
        repository: 'o/r',
        out: '/out/pending.json',
        stateOut: '/out/state',
        pagesUrl: PAGES,
        ciWorkflows: ['ci.yml'],
        reportWorkflow: 'ci-report.yml',
        deployerWorkflow: 'pages-deploy.yml',
        now: NOW,
      },
      io(),
      { fs },
      fetchFn,
    );
    expect(plan.updates.map((u) => [u.id, u.accepted])).toEqual([[300, false]]);
    expect(plan.deletionsDue).toBe(0);
    expect(readFileSync(outputs, 'utf8')).toContain('pending=true');
  });
});
