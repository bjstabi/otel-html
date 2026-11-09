import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createReportWith, resolveDeps } from '../../../src/api/report.js';
import type { ApiRun } from '../../../src/cli/ci/github-api.js';
import { pruneAssets } from '../../../src/cli/ci/site-io.js';
import { runCleanup, runSite } from '../../../src/cli/ci/site-main.js';
import type { CliIo } from '../../../src/cli/io.js';
import type { WriterDeps } from '../../../src/writer/session.js';
import { fakeViewerAssets } from '../../../test-support/writer-deps.js';

const VERSION = '9.9.9';
let dir: string;
let site: string;
let out: string[];
let deps: WriterDeps;
const io = (): CliIo =>
  ({
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => out.push(s),
    env: {},
    cwd: dir,
  }) as unknown as CliIo;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'site-main-'));
  site = join(dir, 'site');
  mkdirSync(site);
  out = [];
  deps = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: VERSION });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const apiRun = (id: number): ApiRun => ({
  id,
  run_attempt: 1,
  name: 'ci',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-01-01T00:00:00Z',
  run_started_at: null,
  updated_at: `2026-01-01T00:0${id}:00Z`,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  head_branch: id === 7 ? 'feat' : 'main',
  head_sha: `sha${id}`,
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
  head_repository: { full_name: 'o/r' },
});

const fetchFn = async (url: string): Promise<Response> => {
  const run = /\/actions\/runs\/(\d+)$/.exec(url);
  if (run) return Response.json(apiRun(Number(run[1])));
  if (url.includes('/commits/sha7/'))
    return Response.json([
      {
        number: 5,
        title: 'Feat',
        state: 'open',
        head: { sha: 'sha7', ref: 'feat', repo: { full_name: 'o/r' } },
      },
    ]);
  if (url.includes('/commits/')) return Response.json([]);
  return Response.json({ default_branch: 'main' });
};

/** A `ci report`-shaped run report: local format, own assets/. */
async function runReport(name: string, at: number): Promise<string> {
  const report = join(dir, name);
  const r = await createReportWith({ out: report, format: 'local', assetsBase: 'assets/' }, deps);
  await r.addLogs({
    resourceLogs: [
      {
        resource: { attributes: [] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: `${1767225600000000000n + BigInt(at)}`,
                severityNumber: 9,
                body: { stringValue: name },
              },
            ],
          },
        ],
      },
    ],
  });
  await r.close();
  return report;
}

const publish = async (report: string, runId: number, d: WriterDeps = deps): Promise<void> =>
  runSite(
    {
      site,
      report,
      runId,
      repository: 'o/r',
      baseUrl: 'https://x.test/r',
      retention: 20,
      prRetention: 5,
    },
    io(),
    d,
    fetchFn,
  );

const manifestText = (folder: string): string => readFileSync(join(folder, 'data/manifest.js'), 'utf8');

describe('runSite in site format', () => {
  test('the rolling report and the run report load the shared assets of this version', async () => {
    await publish(await runReport('a', 1), 1);
    const rolling = manifestText(join(site, 'branch/main'));
    expect(rolling).toContain('"format":"site"');
    expect(rolling).toContain(`"assetsBase":"../../assets/${VERSION}/"`);
    const runManifest = manifestText(join(site, 'branch/main/runs/1'));
    expect(runManifest).toContain(`"assetsBase":"../../../../assets/${VERSION}/"`);
    expect(readFileSync(join(site, 'branch/main/index.html'), 'utf8')).toContain(`../../assets/${VERSION}/`);
    // every base resolves, from the folder that names it, to the shared folder
    for (const folder of ['branch/main', 'branch/main/runs/1']) {
      const base = /"assetsBase":"([^"]+)"/.exec(manifestText(join(site, folder)))?.[1] ?? '';
      expect(resolve(site, folder, base)).toBe(join(site, 'assets', VERSION));
    }
    expect(existsSync(join(site, 'branch/main/assets'))).toBe(false);
    expect(existsSync(join(site, 'branch/main/runs/1/assets'))).toBe(false);
    // one partition per signal in the compacted rolling report
    const partitions = readdirSync(join(site, 'branch/main/data/partitions'));
    expect(partitions).toHaveLength(1);
  });

  test('the shared folder holds the viewer and the plain engine files, and a second publish leaves them', async () => {
    await publish(await runReport('a', 1), 1);
    const shared = join(site, 'assets', VERSION);
    const names = readdirSync(shared).sort();
    expect(names).toContain('viewer.abc123.js');
    expect(names).toContain('duckdb.1.32.0.wasm');
    expect(names).toContain('parquet.1.32.0.duckdb_extension.wasm');
    expect(names).toContain('json.1.32.0.duckdb_extension.wasm');
    expect(names.some((n) => n.endsWith('.b64.js'))).toBe(false);
    const before = statSync(join(shared, 'viewer.abc123.js')).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await publish(await runReport('b', 2), 2);
    expect(statSync(join(shared, 'viewer.abc123.js')).mtimeMs).toBe(before);
  });

  test('a second build of one version adds its viewer files; both reports open and nothing is rewritten', async () => {
    await publish(await runReport('a', 1), 1);
    const shared = join(site, 'assets', VERSION);
    const oldMtime = statSync(join(shared, 'viewer.abc123.js')).mtimeMs;
    const base = fakeViewerAssets();
    const second: WriterDeps = {
      ...deps,
      viewerAssets: {
        entry: () => ({ script: 'assets/viewer.def456.js', style: 'assets/viewer.def456.css' }),
        async files(format) {
          const files = await base.files(format);
          return files.map((f) => ({ ...f, path: f.path.replace('abc123', 'def456') }));
        },
      },
    };
    await new Promise((r) => setTimeout(r, 20));
    await publish(await runReport('b', 2), 2, second);
    const names = readdirSync(shared);
    expect(names).toEqual(expect.arrayContaining(['viewer.abc123.js', 'viewer.abc123.css']));
    expect(names).toEqual(expect.arrayContaining(['viewer.def456.js', 'viewer.def456.css']));
    expect(statSync(join(shared, 'viewer.abc123.js')).mtimeMs).toBe(oldMtime);
    // the new rolling report and the new run report name files that exist; the old run report still does
    expect(readFileSync(join(site, 'branch/main/index.html'), 'utf8')).toContain('viewer.def456.js');
    expect(readFileSync(join(site, 'branch/main/runs/2/index.html'), 'utf8')).toContain('viewer.def456.js');
    expect(readFileSync(join(site, 'branch/main/runs/1/index.html'), 'utf8')).toContain('viewer.abc123.js');
    expect(names.some((n) => n.includes('.tmp-'))).toBe(false);
  });

  test('ci site over a local run report gives a site report on the shared base with no own assets/', async () => {
    const report = await runReport('a', 1);
    expect(manifestText(report)).toContain('"format":"local"');
    await publish(report, 1);
    const run = join(site, 'branch/main/runs/1');
    expect(manifestText(run)).toContain('"format":"site"');
    expect(manifestText(run)).toContain(`"assetsBase":"../../../../assets/${VERSION}/"`);
    expect(existsSync(join(run, 'assets'))).toBe(false);
  });

  test('a version no report references is pruned; the referenced one stays', async () => {
    mkdirSync(join(site, 'assets', '0.0.1'), { recursive: true });
    await publish(await runReport('a', 1), 1);
    expect(readdirSync(join(site, 'assets'))).toEqual([VERSION]);
  });

  test('an older version that a retained run still references is kept', async () => {
    const old = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '0.0.1' });
    await publish(await runReport('a', 1), 1, old);
    await publish(await runReport('b', 2), 2);
    expect(readdirSync(join(site, 'assets')).sort()).toEqual(['0.0.1', VERSION]);
  });

  test('cleanup of a pull request prunes the versions only it used', async () => {
    const old = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '0.0.1' });
    await publish(await runReport('a', 1), 1);
    await publish(await runReport('p', 7), 7, old);
    expect(readdirSync(join(site, 'assets')).sort()).toEqual(['0.0.1', VERSION]);
    await runCleanup({ site, pr: 5, repository: 'o/r' }, io(), deps);
    expect(readdirSync(join(site, 'assets'))).toEqual([VERSION]);
  });

  test('a scratch folder a crashed publish left under assets/ is swept', async () => {
    mkdirSync(join(site, 'assets', '.9.9.9.tmp-1234'), { recursive: true });
    writeFileSync(join(site, 'assets', '.9.9.9.tmp-1234', 'viewer.old.js'), 'x');
    mkdirSync(join(site, 'assets', '.0.0.1.tmp-77'), { recursive: true });
    await publish(await runReport('a', 1), 1);
    expect(readdirSync(join(site, 'assets'))).toEqual([VERSION]);
  });

  test('an empty version folder is not a complete version and is filled', async () => {
    mkdirSync(join(site, 'assets', VERSION), { recursive: true });
    await publish(await runReport('a', 1), 1);
    expect(readdirSync(join(site, 'assets', VERSION))).toContain('viewer.abc123.js');
  });

  test('an unreadable manifest prunes nothing and warns', async () => {
    mkdirSync(join(site, 'assets', '0.0.1'), { recursive: true });
    mkdirSync(join(site, 'pr/3/data'), { recursive: true });
    writeFileSync(join(site, 'pr/3/data/manifest.js'), 'not a manifest');
    const warnings: string[] = [];
    expect(await pruneAssets(site, deps, (m) => warnings.push(m))).toEqual([]);
    expect(existsSync(join(site, 'assets', '0.0.1'))).toBe(true);
    expect(warnings.join()).toContain(join('pr', '3'));
  });
});
