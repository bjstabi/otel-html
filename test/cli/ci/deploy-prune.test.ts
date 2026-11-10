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

const art = (id: number, name: string, run: number) => ({
  id,
  name,
  size_in_bytes: 1000,
  created_at: '2026-11-09T00:00:00Z',
  expires_at: '2027-01-01T00:00:00Z',
  workflow_run: { id: run },
});

function world(artifacts: unknown[], runs = [50, 40, 30, 20, 10]) {
  const deleted: string[] = [];
  const statuses = (run: number) => [
    { state: 'success', log_url: `https://github.com/o/r/actions/runs/${run}/jobs/1`, created_at: NOW },
  ];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'DELETE') {
      deleted.push(url.slice(`${R}/actions/artifacts/`.length));
      return new Response(null, { status: url.endsWith('/403') ? 403 : 204 });
    }
    if (url === `${R}/deployments?environment=github-pages&per_page=100`)
      return Response.json(runs.map((r) => ({ id: r * 10, created_at: NOW, environment: 'github-pages' })));
    const m = /deployments\/(\d+)\/statuses/.exec(url);
    if (m) return Response.json(statuses(Number(m[1]) / 10));
    if (url === `${R}/actions/artifacts?per_page=100`) return Response.json({ artifacts });
    throw new Error(`unexpected request: ${url}`);
  };
  return { fetchFn, deleted };
}

const applied = (passes: Record<string, number>) => ({
  version: 1 as const,
  form: { kind: 'full' as const, runId: 50 },
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
    art(12, 'github-pages', 60), // a pass in flight
    art(21, 'otel-html-update-push-1-1', 5),
    art(22, 'otel-html-update-push-1-2', 5),
    art(23, 'otel-html-update-push-1-3', 5),
    art(24, 'otel-html-update-push-1-4', 5),
    art(25, 'otel-html-update-push-1-5', 5), // pending, not recorded
    art(30, 'unrelated', 10),
  ];
  const base = { apiUrl: API, repository: 'o/r', keep: 3, now: NOW, token: 'tok' };

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
    await pruneArtifacts({ ...base, currentRunId: 60, applied: applied({}) }, fetchFn, () => {});
    // kept = 50, 40, 30 (not 45): the artifacts of 30 stay, 25 and older go
    expect(deleted).not.toContain('4');
    expect(deleted).not.toContain('5');
    expect(deleted).toContain('6');
    expect(deleted).not.toContain('12');
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
