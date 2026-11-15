import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { runDeployScan } from '../../../src/cli/ci/deploy-main.js';
import { fetchLiveSite, pruneArtifacts } from '../../../src/cli/ci/deploy-prune.js';
import { emptyState, scanFiles, writeSiteState } from '../../../src/cli/ci/site-state.js';
import type { CliIo } from '../../../src/cli/io.js';
import { createMemoryFileSystem } from '../../../test-support/memory-fs.js';

const API = 'https://api.test';
const R = `${API}/repos/o/r`;
const NOW = '2026-11-10T12:00:00Z';

const art = (id: number, name: string, run: number, createdAt = '2026-11-09T00:00:00Z') => ({
  id,
  name,
  size_in_bytes: 1000,
  created_at: createdAt,
  expires_at: '2027-01-01T00:00:00Z',
  workflow_run: { id: run },
});

/** The time a run's deployment went live: later runs later, unless `live` says otherwise. */
const liveAt = (run: number): string => new Date(Date.parse(NOW) - (100 - run) * 1000).toISOString();

const apiRun = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  run_attempt: 1,
  event: 'push',
  path: '.github/workflows/ci.yml',
  actor: { type: 'User' },
  head_branch: 'main',
  head_repository: { full_name: 'o/r' },
  ...over,
});

function world(
  artifacts: unknown[],
  runs = [50, 40, 30, 20, 10],
  more: { live?: Record<number, string>; runOver?: Record<number, Record<string, unknown>> } = {},
) {
  const deleted: string[] = [];
  const at = (run: number): string => more.live?.[run] ?? liveAt(run);
  const statuses = (run: number) => [
    { state: 'success', log_url: `https://github.com/o/r/actions/runs/${run}/jobs/1`, created_at: at(run) },
  ];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'DELETE') {
      deleted.push(url.slice(`${R}/actions/artifacts/`.length));
      return new Response(null, { status: url.endsWith('/403') ? 403 : 204 });
    }
    if (url === R) return Response.json({ default_branch: 'main' });
    const run = /\/actions\/runs\/(\d+)$/.exec(url);
    if (run) return Response.json(apiRun(Number(run[1]), more.runOver?.[Number(run[1])]));
    if (url === `${R}/deployments?environment=github-pages&per_page=100`)
      return Response.json(runs.map((r) => ({ id: r * 10, created_at: at(r), environment: 'github-pages' })));
    const m = /deployments\/(\d+)\/statuses/.exec(url);
    if (m) return Response.json(statuses(Number(m[1]) / 10));
    if (url === `${R}/actions/artifacts?per_page=100`) return Response.json({ artifacts });
    throw new Error(`unexpected request: ${url}`);
  };
  return { fetchFn, deleted };
}

const applied = (passes: Record<string, number>) => ({
  version: 1 as const,
  form: { kind: 'full' as const, runId: 50, runAttempt: 1 },
  updates: Object.fromEntries(
    Object.entries(passes).map(([id, pass]) => [id, { outcome: 'applied' as const, createdAt: NOW, pass }]),
  ),
  floor: NOW,
  writtenAt: NOW,
});

describe('pruneArtifacts', () => {
  const artifacts = [
    art(1, 'github-pages', 50),
    art(2, 'otel-html-site-state-50', 50),
    art(3, 'github-pages', 40),
    art(4, 'github-pages', 30),
    art(5, 'otel-html-site-state-30', 30),
    art(6, 'github-pages', 25), // a failed pass
    art(7, 'otel-html-site-state-25', 25),
    art(8, 'github-pages', 20),
    art(9, 'otel-html-site-state-20', 20),
    art(10, 'github-pages', 10),
    art(11, 'otel-html-site-state-base-77', 10),
    art(12, 'github-pages', 60, NOW), // a pass in flight
    art(21, 'otel-html-update-push-1-1', 5),
    art(22, 'otel-html-update-push-1-2', 5),
    art(23, 'otel-html-update-push-1-3', 5),
    art(24, 'otel-html-update-push-1-4', 5),
    art(25, 'otel-html-update-push-1-5', 5), // pending, not recorded
    art(30, 'unrelated', 10),
  ];
  const base = {
    apiUrl: API,
    repository: 'o/r',
    keep: 3,
    now: NOW,
    token: 'tok',
    ciWorkflows: ['ci.yml'],
    deployerWorkflows: ['pages-deploy.yml'],
  };

  test('deletes older deployments artifacts, a failed pass and updates consumed up to the oldest kept pass', async () => {
    const { fetchFn, deleted } = world(artifacts);
    const out = await pruneArtifacts(
      { ...base, applied: applied({ '21': 10, '22': 20, '23': 30, '24': 40, '999': 5 }) },
      fetchFn,
      () => {},
    );
    expect(deleted.sort()).toEqual(['10', '11', '21', '22', '23', '6', '7', '8', '9'].sort());
    expect(out.deleted.sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11, 21, 22, 23]);
  });

  test('a no-op deployer run and the current run are not counted as kept deployments', async () => {
    // 45 is a no-op deployer run (no artifacts), 60 the running pass (its deployment is already listed)
    const { fetchFn, deleted } = world(artifacts, [60, 50, 45, 40, 30, 20, 10]);
    await pruneArtifacts(
      { ...base, current: { runId: 60, runAttempt: 1 }, applied: applied({}) },
      fetchFn,
      () => {},
    );
    // kept = 50, 40, 30 (not 45): the artifacts of 30 stay, 25 and older go
    expect(deleted).not.toContain('4');
    expect(deleted).not.toContain('5');
    expect(deleted).toContain('6');
    expect(deleted).not.toContain('12');
  });

  test('the per-attempt names count as the site of a run and older runs go', async () => {
    const arts = [
      art(1, 'github-pages-1', 50),
      art(2, 'otel-html-site-state-50-1', 50),
      art(3, 'github-pages-1', 40),
      art(4, 'github-pages-1', 30),
      art(5, 'otel-html-site-state-30-1', 30),
      art(6, 'github-pages-1', 20),
      art(7, 'otel-html-site-state-20-1', 20),
      art(8, 'otel-html-site-state-base-77-1', 10),
    ];
    const { fetchFn, deleted } = world(arts);
    await pruneArtifacts({ ...base, applied: applied({}) }, fetchFn, () => {});
    expect(deleted.sort()).toEqual(['6', '7', '8']);
  });

  test('a fork pull_request run with a deployment, a tarball and a state is never kept and forces no deletion', async () => {
    // 57, 56 and 55 are forged deployments of one fork's pull_request ci.yml runs (the newest three)
    const fork = { event: 'pull_request', head_branch: 'feat', head_repository: { full_name: 'evil/r' } };
    const arts = [
      ...[55, 56, 57].flatMap((r) => [
        art(r * 10, 'github-pages-1', r, NOW),
        art(r * 10 + 1, 'otel-html-site-state-' + r + '-1', r, NOW),
      ]),
      ...artifacts,
    ];
    const { fetchFn, deleted } = world(arts, [57, 56, 55, 50, 40, 30, 20, 10], {
      runOver: { 55: fork, 56: fork, 57: fork },
    });
    await pruneArtifacts({ ...base, applied: applied({ '21': 10, '24': 40 }) }, fetchFn, () => {});
    // kept = 50, 40, 30: their artifacts and the in-flight pass stay; the forged runs' artifacts are not kept status, but are not older than the oldest kept either
    for (const id of ['1', '2', '3', '4', '5', '12', '24']) expect(deleted).not.toContain(id);
    expect(deleted).toContain('21');
    expect(deleted).toContain('8');
  });

  test('a fork run cannot push the real base out of the kept deployments', async () => {
    const fork = { event: 'pull_request', head_branch: 'main', head_repository: { full_name: 'evil/r' } };
    const arts = [
      art(1, 'github-pages-1', 50),
      art(2, 'otel-html-site-state-50-1', 50),
      art(3, 'github-pages-1', 40),
      ...[53, 54, 55].map((r) => art(r * 10, 'github-pages-1', r, NOW)),
      art(30, 'github-pages-1', 20),
    ];
    const { fetchFn, deleted } = world(arts, [55, 54, 53, 50, 40, 20], {
      runOver: { 55: fork, 54: fork, 53: fork },
    });
    // kept = 50, 40, 20 (the trusted ones): nothing older than run 20 exists, and 50's tarball stays
    await pruneArtifacts({ ...base, applied: applied({}) }, fetchFn, () => {});
    expect(deleted).not.toContain('1');
    expect(deleted).not.toContain('2');
    expect(deleted).not.toContain('3');
  });

  test('a trusted ci run and a legacy pages-deploy run still count', async () => {
    const legacy = {
      path: '.github/workflows/pages-deploy.yml',
      event: 'workflow_dispatch',
      actor: { type: 'Bot' },
    };
    const arts = [
      art(1, 'github-pages', 50),
      art(3, 'github-pages', 40),
      art(4, 'github-pages', 30),
      art(8, 'github-pages', 20),
    ];
    const { fetchFn, deleted } = world(arts, [50, 40, 30, 20], { runOver: { 40: legacy, 30: legacy } });
    await pruneArtifacts({ ...base, applied: applied({}) }, fetchFn, () => {});
    expect(deleted).toEqual(['8']);
  });

  test("a re-run of an older run that deployed last: the newest deployment's consumed updates stay", async () => {
    // run 20 was re-run and went live after 50, 40 and 30: kept = 20 (newest), 50, 40; the oldest kept by time is 40
    const live = { 20: '2026-11-10T11:59:00Z', 50: '2026-11-10T11:30:00Z', 40: '2026-11-10T11:00:00Z' };
    const arts = [
      art(1, 'github-pages-1', 50, '2026-11-10T11:29:00Z'),
      art(3, 'github-pages-1', 40, '2026-11-10T10:59:00Z'),
      art(8, 'github-pages-1', 20, '2026-11-10T11:58:00Z'),
      art(4, 'github-pages-1', 30, '2026-11-10T10:30:00Z'),
      art(21, 'otel-html-update-push-1-1', 5),
      art(22, 'otel-html-update-push-1-2', 5),
      art(23, 'otel-html-update-push-1-3', 5),
    ];
    const { fetchFn, deleted } = world(arts, [20, 50, 40, 30], { live });
    // 21 was consumed by the re-run (live last), 22 by 40 (the oldest kept), 23 by 50
    await pruneArtifacts({ ...base, applied: applied({ '21': 20, '22': 40, '23': 50 }) }, fetchFn, () => {});
    expect(deleted.sort()).toEqual(['22', '4']);
  });

  test('a failed delete is a warning and the rest proceed', async () => {
    const { fetchFn, deleted } = world(artifacts);
    const warnings: string[] = [];
    const forbidding = async (url: string, init?: RequestInit): Promise<Response> =>
      init?.method === 'DELETE' && url.endsWith('/8')
        ? new Response(null, { status: 403 })
        : fetchFn(url, init);
    const out = await pruneArtifacts({ ...base, applied: applied({}) }, forbidding, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('403');
    expect(out.deleted).not.toContain(8);
    expect(deleted).toContain('9');
    expect(deleted).toContain('10');
  });

  test('fewer successful deployments than kept deletes nothing', async () => {
    const { fetchFn, deleted } = world(artifacts);
    await pruneArtifacts({ ...base, keep: 9, applied: applied({ '21': 1 }) }, fetchFn, () => {});
    expect(deleted).toEqual([]);
  });
});

describe('fetchLiveSite', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  async function serve(
    files: Record<string, string>,
    listed: Record<string, number>,
    listing: string = JSON.stringify({ version: 1, files: listed }),
  ): Promise<string> {
    server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '').slice(1));
      if (path === 'site/site-state/files.json') {
        res.end(listing);
      } else if (files[path.slice('site/'.length)] !== undefined) res.end(files[path.slice('site/'.length)]);
      else {
        res.statusCode = 404;
        res.end('no');
      }
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/site`;
  }

  test('writes every listed file', async () => {
    const pagesUrl = await serve(
      { 'index.json': '{"a":1}', 'a/b c.txt': 'hello' },
      { 'index.json': 7, 'a/b c.txt': 5 },
    );
    const fs = createMemoryFileSystem();
    expect(await fetchLiveSite({ pagesUrl, out: '/base' }, fs, fetch)).toEqual({ files: 2, bytes: 12 });
    expect(await fs.readText('/base/a/b c.txt')).toBe('hello');
  });

  test('rejects a size mismatch and a missing file', async () => {
    const pagesUrl = await serve({ 'x.txt': 'hello' }, { 'x.txt': 4 });
    await expect(
      fetchLiveSite({ pagesUrl, out: '/base' }, createMemoryFileSystem(), fetch),
    ).rejects.toMatchObject({
      code: 'invalid-report',
    });
  });

  test('rejects a missing file', async () => {
    const pagesUrl = await serve({}, { 'gone.txt': 4 });
    await expect(
      fetchLiveSite({ pagesUrl, out: '/base' }, createMemoryFileSystem(), fetch),
    ).rejects.toMatchObject({
      code: 'invalid-report',
    });
  });

  test.each([
    ['no files key', '{"version":1}'],
    ['null', 'null'],
    ['an array', '[]'],
    ['not JSON', '<html>'],
    ['an empty listing', '{"version":1,"files":{}}'],
    ['a non-integer size', '{"version":1,"files":{"a":1.5}}'],
  ])('rejects a listing that is %s', async (_n, body) => {
    const pagesUrl = await serve({}, {}, body);
    await expect(
      fetchLiveSite({ pagesUrl, out: '/base' }, createMemoryFileSystem(), fetch),
    ).rejects.toMatchObject({
      code: 'invalid-report',
    });
  });

  test('a write failure (paths a and a/b) is invalid-report', async () => {
    const pagesUrl = await serve({ a: 'x', 'a/b': 'y' }, { a: 1, 'a/b': 1 });
    await expect(
      fetchLiveSite({ pagesUrl, out: '/base' }, createMemoryFileSystem(), fetch),
    ).rejects.toMatchObject({
      code: 'invalid-report',
    });
  });

  test.each(['../evil', '/abs', 'a\\b', 'a/../../b', 'a//b', 'site-state/applied.json'])(
    'rejects the unsafe path %s before writing',
    async (path) => {
      const pagesUrl = await serve({}, { [path]: 1 });
      const fs = createMemoryFileSystem();
      await expect(fetchLiveSite({ pagesUrl, out: '/base' }, fs, fetch)).rejects.toMatchObject({
        code: 'invalid-report',
      });
      expect(fs.snapshot().size).toBe(0);
    },
  );
});

describe('runDeployScan', () => {
  test('lists a file written after the state, with its size', async () => {
    const fs = createMemoryFileSystem();
    await fs.mkdirp('/site/b');
    await fs.writeBytes('/site/b/x.txt', new TextEncoder().encode('abc'));
    await writeSiteState(fs, '/site/site-state', { ...emptyState(NOW), files: await scanFiles(fs, '/site') });
    await fs.writeBytes('/site/preview-light.png', new Uint8Array(42));
    await runDeployScan({ site: '/site' }, { stdout: () => {} } as unknown as CliIo, { fs });
    const files = JSON.parse(await fs.readText('/site/site-state/files.json'));
    expect(files.files['preview-light.png']).toBe(42);
    expect(files.files['b/x.txt']).toBe(3);
  });
});
