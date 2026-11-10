import { describe, expect, test } from 'vitest';
import { downloadArtifact } from '../../../src/cli/ci/deploy-fetch.js';
import { runDeployFetch } from '../../../src/cli/ci/deploy-main.js';
import type { PendingPlan, PendingUpdate } from '../../../src/cli/ci/deploy-plan.js';
import type { CliIo } from '../../../src/cli/io.js';
import { createMemoryFileSystem } from '../../../test-support/memory-fs.js';
import { buildZip } from '../../../test-support/zip.js';

const API = 'https://api.test';
const ZIP_URL = `${API}/repos/o/r/actions/artifacts/5/zip`;
const zip = buildZip([
  { name: 'update.json', data: '{"a":1}' },
  { name: 'ci/spans.parquet', data: 'PAR1', method: 'deflate' },
]);
const i = { apiUrl: API, repository: 'o/r', id: 5, out: '/out/u', maxBytes: 1000 };

function server(handlers: Record<string, (init?: RequestInit) => Response>) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url, ...(init === undefined ? {} : { init }) });
    const h = handlers[url];
    if (h === undefined) throw new Error(`unexpected request: ${url}`);
    return h(init);
  };
  return { fetchFn, seen };
}
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });

describe('downloadArtifact', () => {
  test('follows the redirect without the Authorization header and writes the entries', async () => {
    const { fetchFn, seen } = server({
      [ZIP_URL]: redirect('https://blob.test/x'),
      'https://blob.test/x': () => new Response(zip),
    });
    const fs = createMemoryFileSystem();
    expect(await downloadArtifact(i, fs, 'tok', fetchFn)).toEqual({ files: 2, bytes: 11 });
    expect(await fs.readText('/out/u/update.json')).toBe('{"a":1}');
    expect(await fs.readText('/out/u/ci/spans.parquet')).toBe('PAR1');
    expect(JSON.stringify(seen[0]?.init?.headers)).toContain('Bearer tok');
    expect(JSON.stringify(seen[1]?.init?.headers ?? {})).not.toContain('Authorization');
  });

  test('refuses a redirect to a non-https URL', async () => {
    const { fetchFn } = server({ [ZIP_URL]: redirect('http://blob.test/x') });
    await expect(downloadArtifact(i, createMemoryFileSystem(), 'tok', fetchFn)).rejects.toThrow(/non-https/);
  });

  test('refuses a zip over maxBytes and a failing status', async () => {
    const { fetchFn } = server({ [ZIP_URL]: () => new Response(zip) });
    await expect(
      downloadArtifact({ ...i, maxBytes: 5 }, createMemoryFileSystem(), 'tok', fetchFn),
    ).rejects.toThrow();
    const gone = server({ [ZIP_URL]: () => new Response('', { status: 404 }) });
    await expect(downloadArtifact(i, createMemoryFileSystem(), 'tok', gone.fetchFn)).rejects.toThrow(/404/);
  });
});

const update = (id: number, accepted = true): PendingUpdate => ({
  id,
  name: `otel-html-update-push-7-${id}`,
  parsed: { kind: 'push', jobKey: '7', sequence: id },
  createdAt: '2026-11-10T11:00:00Z',
  sizeBytes: 10,
  uploader: {
    runId: 21,
    path: '.github/workflows/ci.yml',
    event: 'push',
    headBranch: 'main',
    sameRepo: true,
  },
  run: null,
  channel: null,
  accepted,
  ...(accepted ? {} : { reason: 'nope' }),
});

describe('runDeployFetch', () => {
  test('downloads each accepted update to <out>/<name>/ and marks a failing one rejected', async () => {
    const plan: PendingPlan = {
      version: 1,
      base: { kind: 'empty' },
      state: null,
      updates: [update(5), update(6), update(7, false)],
      deletionsDue: 0,
      floor: '2026-11-10T10:00:00.000Z',
      now: '2026-11-10T12:00:00Z',
    };
    const fs = createMemoryFileSystem();
    await fs.mkdirp('/p');
    await fs.writeTextAtomic('/p/pending.json', JSON.stringify(plan));
    const { fetchFn } = server({
      [ZIP_URL]: redirect('https://blob.test/x'),
      'https://blob.test/x': () => new Response(zip),
      [`${API}/repos/o/r/actions/artifacts/6/zip`]: () => new Response('', { status: 404 }),
    });
    const out: string[] = [];
    const io = {
      stdout: (s: string) => out.push(s),
      stderr: () => {},
      env: { GITHUB_API_URL: API, GITHUB_TOKEN: 'tok' },
      cwd: '/',
    } as unknown as CliIo;
    await runDeployFetch({ repository: 'o/r', pending: '/p/pending.json', out: '/out' }, io, { fs }, fetchFn);
    expect(await fs.readText('/out/otel-html-update-push-7-5/update.json')).toBe('{"a":1}');
    expect(await fs.exists('/out/otel-html-update-push-7-6')).toBe(false);
    const rewritten = JSON.parse(await fs.readText('/p/pending.json')) as PendingPlan;
    expect(rewritten.updates.map((u) => [u.id, u.accepted])).toEqual([
      [5, true],
      [6, false],
      [7, false],
    ]);
    expect(rewritten.updates[1]?.reason).toMatch(/^download failed: .*404/);
  });
});
