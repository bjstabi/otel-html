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
import type { ApiPull, ApiRun } from '../../../src/cli/ci/github-api.js';
import { channelFor, siteRunOf } from '../../../src/cli/ci/site.js';
import { pruneAssets, removePaths } from '../../../src/cli/ci/site-io.js';
import { placeFinishedRun, removePullRequest } from '../../../src/cli/ci/site-main.js';
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

const apiRun = (id: number, over: Partial<ApiRun> = {}): ApiRun => ({
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
  path: '.github/workflows/ci.yml',
  actor: { type: 'User' },
  head_branch: id === 7 ? 'feat' : 'main',
  head_sha: `sha${id}`,
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
  head_repository: { full_name: 'o/r' },
  ...over,
});

const pull = (number: number, ref: string, sha: string): ApiPull => ({
  number,
  title: 'Feat',
  state: 'open',
  head: { sha, ref, repo: { full_name: 'o/r' } },
});
const PULLS: Record<string, ApiPull[]> = { sha7: [pull(5, 'feat', 'sha7')] };

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

type Place = { retention?: number; prRetention?: number; config?: string };

/** What `ci site` did: resolve the run's channel and place its report. `undefined` when the run has no channel. */
const publishRun = async (
  run: ApiRun,
  pulls: ApiPull[],
  report: string,
  d: WriterDeps,
  o: Place = {},
): Promise<{ rolling: 'built' | 'stub' } | undefined> => {
  const placed = channelFor(run, pulls, 'main');
  if (placed === undefined) return undefined;
  return placeFinishedRun(site, placed, siteRunOf(run, `${placed.key}/runs/${run.id}`), report, {
    retention: o.retention ?? 20,
    prRetention: o.prRetention ?? 5,
    config: o.config,
    repository: 'o/r',
    deps: d,
    io: io(),
    remove: removePaths,
  });
};

const publish = async (
  report: string,
  runId: number,
  d: WriterDeps = deps,
  o: Place = {},
): Promise<{ rolling: 'built' | 'stub' } | undefined> =>
  publishRun(apiRun(runId), PULLS[`sha${runId}`] ?? [], report, d, o);

const manifestText = (folder: string): string => readFileSync(join(folder, 'data/manifest.js'), 'utf8');

describe('placeFinishedRun in site format', () => {
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

  test('placing a local run report gives a site report on the shared base with no own assets/', async () => {
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

  test('removing a pull request prunes the versions only it used', async () => {
    const old = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '0.0.1' });
    await publish(await runReport('a', 1), 1);
    await publish(await runReport('p', 7), 7, old);
    expect(readdirSync(join(site, 'assets')).sort()).toEqual(['0.0.1', VERSION]);
    expect(await removePullRequest(site, 5, 'o/r', deps, io(), removePaths)).toBe(true);
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

/** Makes the run report at `report` a format-4 one: its manifest says so, as a report an older otel-html wrote. */
const asFormat4 = (report: string, assetsBase?: string): void => {
  const path = join(report, 'data/manifest.js');
  let text = readFileSync(path, 'utf8').replace('"formatVersion":5', '"formatVersion":4');
  if (assetsBase !== undefined) text = text.replace(/"assetsBase":"[^"]*"/, `"assetsBase":"${assetsBase}"`);
  writeFileSync(path, text);
};

describe('a format-4 report on the site', () => {
  test('pruning still runs: the format-4 report keeps its assets, an unreferenced version goes, no warning', async () => {
    await publish(await runReport('a', 1), 1);
    const old = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '0.0.1' });
    await publish(await runReport('p', 7), 7, old);
    mkdirSync(join(site, 'assets', '0.0.2'), { recursive: true });
    // the pull request's rolling report and its run report both reference 0.0.1, and both are format 4
    asFormat4(join(site, 'pr/5'));
    asFormat4(join(site, 'pr/5/runs/7'));
    const warnings: string[] = [];
    expect(await pruneAssets(site, deps, (m) => warnings.push(m))).toEqual(['0.0.2']);
    expect(warnings).toEqual([]);
    expect(readdirSync(join(site, 'assets')).sort()).toEqual(['0.0.1', VERSION]);
  });

  test('the rolling report is built from the format-5 run, with a skipping warning and no stub', async () => {
    await publish(await runReport('a', 60), 60);
    asFormat4(join(site, 'branch/main/runs/60'));
    expect(await publish(await runReport('b', 62), 62)).toEqual({ rolling: 'built' });
    expect(out.join('')).toMatch(/::warning::otel-html report: skipping .*runs[\\/]60/);
    expect(existsSync(join(site, 'branch/main/data/manifest.js'))).toBe(true);
    expect(readFileSync(join(site, 'branch/main/data/manifest.js'), 'utf8')).toContain('"formatVersion":5');
    expect(existsSync(join(site, 'branch/main/index.html'))).toBe(true);
    expect(readFileSync(join(site, 'branch/main/index.html'), 'utf8')).not.toContain('url=runs/');
  });
});

const indexOf = (): { channels: Record<string, { runs: { runId: number; workflow?: string }[] }> } =>
  JSON.parse(readFileSync(join(site, 'index.json'), 'utf8'));
const ids = (key: string): number[] => indexOf().channels[key]?.runs.map((r) => r.runId) ?? [];
const legacyRun = (key: string, id: number, over: object = {}): object => ({
  runId: id,
  attempt: 1,
  conclusion: 'success',
  headSha: 'x',
  headBranch: 'main',
  completedAt: '2025-01-01T00:00:00Z',
  runUrl: 'u',
  reportPath: `${key}/runs/${id}`,
  ...over,
});

describe('placing runs on the site', () => {
  test('republishing an old run with retention 1 keeps it on the site and in the index', async () => {
    await publish(await runReport('a', 43), 43, deps, { retention: 1 });
    await publish(await runReport('b', 42), 42, deps, { retention: 1 });
    expect(existsSync(join(site, 'branch/main/runs/42/data/manifest.js'))).toBe(true);
    expect(ids('branch/main')).toEqual([43, 42]);
  });

  test('places a default-branch run, rebuilds the rolling report and applies retention', async () => {
    expect(await publish(await runReport('a', 42), 42)).toEqual({ rolling: 'built' });
    expect(existsSync(join(site, 'branch/main/runs/42/data/manifest.js'))).toBe(true);
    expect(existsSync(join(site, 'branch/main/data/manifest.js'))).toBe(true);
    await publish(await runReport('b', 43), 43, deps, { retention: 1 });
    expect(existsSync(join(site, 'branch/main/runs/42'))).toBe(false);
    expect(existsSync(join(site, 'branch/main/runs/43/data/manifest.js'))).toBe(true);
    expect(readFileSync(join(site, 'index.html'), 'utf8')).toContain('href="branch/main/"');
  });

  test('a retained run that is no longer a report is skipped with a warning; the rest still merge', async () => {
    await publish(await runReport('a', 60), 60);
    rmSync(join(site, 'branch/main/runs/60'), { recursive: true });
    mkdirSync(join(site, 'branch/main/runs/60'));
    writeFileSync(join(site, 'branch/main/runs/60/data'), 'garbage');
    await publish(await runReport('b', 62), 62);
    expect(out.join('')).toContain('::warning::otel-html report: skipping');
    expect(existsSync(join(site, 'branch/main/runs/62/data/manifest.js'))).toBe(true);
    expect(existsSync(join(site, 'branch/main/data/manifest.js'))).toBe(true);
  });

  test("writes a badge file per workflow beside the rolling report, from each workflow's newest run", async () => {
    const badge = (name: string): unknown =>
      JSON.parse(readFileSync(join(site, 'branch/main', name), 'utf8'));
    const place = async (id: number, over: Partial<ApiRun>): Promise<void> => {
      await publishRun(apiRun(id, over), [], await runReport(`r${id}`, id), deps);
    };
    await place(80, {});
    const ci = { schemaVersion: 1, label: 'ci report', message: '✓ 52s', color: 'brightgreen' };
    expect(badge('badge-ci.json')).toMatchObject({ label: 'ci report', color: 'brightgreen' });
    await place(81, { name: 'load' });
    expect(badge('badge-ci.json')).toMatchObject({ label: ci.label });
    expect(badge('badge-load.json')).toMatchObject({ label: 'load report' });
    // an older failed ci run does not take over the ci badge
    await place(82, { conclusion: 'failure', updated_at: '2025-12-31T00:00:00Z' });
    expect(badge('badge-ci.json')).toMatchObject({ color: 'brightgreen' });
    expect(indexOf().channels['branch/main']?.runs[0]).toHaveProperty('startedAt');
  });

  test('a rolling merge that fails with nothing to blame warns and leaves the redirect stub', async () => {
    await publish(await runReport('a', 69), 69);
    expect(existsSync(join(site, 'branch/main/data/manifest.js'))).toBe(true);
    const result = await publish(await runReport('b', 70), 70, deps, { config: join(dir, 'missing.yaml') });
    expect(result).toEqual({ rolling: 'stub' });
    expect(out.join('')).toContain('::warning::otel-html site: rolling report of branch/main not rebuilt');
    expect(readFileSync(join(site, 'branch/main/index.html'), 'utf8')).toContain('url=runs/70/');
    // the previous rolling report does not linger beside the stub
    expect(readdirSync(join(site, 'branch/main')).sort()).toEqual(['badge-ci.json', 'index.html', 'runs']);
    expect(existsSync(join(site, 'branch/main/runs/69/data/manifest.js'))).toBe(true);
  });

  test('preview-*.png in the channel folder survive a built rebuild and a stub fallback; other files do not', async () => {
    const channelDir = join(site, 'branch/main');
    const previews = { 'preview-light.png': 'light bytes', 'preview-dark.png': 'dark bytes' };
    const putPreviews = (): void => {
      mkdirSync(channelDir, { recursive: true });
      for (const [name, bytes] of Object.entries(previews)) writeFileSync(join(channelDir, name), bytes);
      writeFileSync(join(channelDir, 'other.png'), 'not a preview');
    };
    const expectKept = (): void => {
      for (const [name, bytes] of Object.entries(previews))
        expect(readFileSync(join(channelDir, name), 'utf8')).toBe(bytes);
      expect(existsSync(join(channelDir, 'other.png'))).toBe(false);
    };
    putPreviews();
    await publish(await runReport('a', 71), 71);
    expect(existsSync(join(channelDir, 'data/manifest.js'))).toBe(true);
    expectKept();
    putPreviews();
    await publish(await runReport('b', 72), 72, deps, { config: join(dir, 'missing.yaml') });
    expect(existsSync(join(channelDir, 'data/manifest.js'))).toBe(false);
    expectKept();
  });

  test("a pull request's runs of every workflow share one rolling report at pr/<n>", async () => {
    const topic = [pull(7, 'feat/topic', 'sha50')];
    const place = async (id: number, name: string): Promise<void> => {
      await publishRun(
        apiRun(id, { head_branch: 'feat/topic', name }),
        topic,
        await runReport(`r${id}`, id),
        deps,
      );
    };
    await place(50, 'ci');
    await place(51, 'load');
    expect(existsSync(join(site, 'pr/7/data/manifest.js'))).toBe(true);
    expect(existsSync(join(site, 'pr/7/runs/50/data/manifest.js'))).toBe(true);
    expect(existsSync(join(site, 'pr/7/runs/51/data/manifest.js'))).toBe(true);
    expect(indexOf().channels['pr/7']).toMatchObject({
      kind: 'pr',
      title: '#7 Feat',
      headBranch: 'feat/topic',
      headRepo: 'o/r',
    });
    expect(indexOf().channels['pr/7']?.runs.map((r) => r.workflow)).toEqual(['load', 'ci']);
    const landing = readFileSync(join(site, 'index.html'), 'utf8');
    expect(landing).toContain('href="pr/7/"');
    expect(landing).toContain('feat/topic');
  });

  test('a pull request channel keeps its retention per workflow', async () => {
    const runs = [
      legacyRun('pr/7', 11, { workflow: 'load', headBranch: 'feat/topic' }),
      ...Array.from({ length: 10 }, (_, i) =>
        legacyRun('pr/7', 10 - i, {
          workflow: 'ci',
          headBranch: 'feat/topic',
          completedAt: `2025-01-01T00:00:${String(10 - i).padStart(2, '0')}Z`,
        }),
      ),
    ];
    mkdirSync(join(site, 'pr/7/runs/1'), { recursive: true });
    writeFileSync(
      join(site, 'index.json'),
      JSON.stringify({
        version: 1,
        channels: { 'pr/7': { kind: 'pr', title: '#7 Fix', headBranch: 'feat/topic', runs } },
      }),
    );
    await publishRun(
      apiRun(50, { head_branch: 'feat/topic' }),
      [pull(7, 'feat/topic', 'sha50')],
      await runReport('a', 50),
      deps,
      { prRetention: 10 },
    );
    const kept = ids('pr/7');
    expect(kept).toHaveLength(11);
    expect(kept[0]).toBe(50);
    expect(kept).toContain(11);
    expect(kept).not.toContain(1);
    expect(existsSync(join(site, 'pr/7/runs/1'))).toBe(false);
  });

  test('the next placement drops the older per-workflow channels and their folders', async () => {
    const old = (key: string): object => ({
      kind: 'workflow',
      title: key,
      headBranch: 'main',
      runs: [legacyRun(key, 1)],
    });
    for (const key of ['ci', 'load']) mkdirSync(join(site, key, 'runs/1'), { recursive: true });
    writeFileSync(join(site, 'ci/index.html'), 'old rolling report');
    mkdirSync(join(site, 'pr/3/runs/9'), { recursive: true });
    const legacyPr = { kind: 'pr', title: '#3 Old', headBranch: 'old', runs: [legacyRun('pr/3', 9)] };
    writeFileSync(
      join(site, 'index.json'),
      JSON.stringify({ version: 1, channels: { ci: old('ci'), load: old('load'), 'pr/3': legacyPr } }),
    );
    await publish(await runReport('a', 42), 42);
    expect(out.join('')).toContain('removed the per-workflow channels ci, load');
    expect(existsSync(join(site, 'ci'))).toBe(false);
    expect(existsSync(join(site, 'load'))).toBe(false);
    expect(existsSync(join(site, 'pr/3/runs/9'))).toBe(true);
    expect(Object.keys(indexOf().channels).sort()).toEqual(['branch/main', 'pr/3']);
    const landing = readFileSync(join(site, 'index.html'), 'utf8');
    expect(landing).not.toContain('href="ci/"');
    expect(landing).toContain('href="pr/3/"');
  });

  test('a channel of a kind this version does not know is skipped with a warning, not a failure', async () => {
    writeFileSync(
      join(site, 'index.json'),
      JSON.stringify({
        version: 1,
        channels: { 'tag/v1': { kind: 'tag', title: 'v1', headBranch: 'v1', runs: [] } },
      }),
    );
    await publish(await runReport('a', 42), 42);
    expect(out.join('')).toContain('::warning::otel-html site: skipping channel tag/v1 of kind tag');
    expect(await removePullRequest(site, 1, 'o/r', deps, io(), removePaths)).toBe(false);
  });

  test('a stub-era pr channel is rebuilt as a rolling report by its next run', async () => {
    mkdirSync(join(site, 'pr/7'), { recursive: true });
    writeFileSync(join(site, 'pr/7/index.html'), '<meta http-equiv="refresh" content="0; url=runs/49/">');
    writeFileSync(
      join(site, 'index.json'),
      JSON.stringify({
        version: 1,
        channels: { 'pr/7': { kind: 'pr', title: '#7 Fix', headBranch: 'feat/topic', runs: [] } },
      }),
    );
    await publishRun(
      apiRun(50, { head_branch: 'feat/topic' }),
      [pull(7, 'feat/topic', 'sha50')],
      await runReport('a', 50),
      deps,
    );
    expect(existsSync(join(site, 'pr/7/data/manifest.js'))).toBe(true);
    expect(readFileSync(join(site, 'pr/7/index.html'), 'utf8')).not.toContain('url=runs/49/');
  });
});

describe('removePullRequest', () => {
  test('removes the pull request channel and folder; an unknown one changes nothing', async () => {
    await publish(await runReport('p', 7), 7);
    expect(existsSync(join(site, 'pr/5/runs/7/data/manifest.js'))).toBe(true);
    expect(await removePullRequest(site, 5, 'o/r', deps, io(), removePaths)).toBe(true);
    expect(existsSync(join(site, 'pr/5'))).toBe(false);
    expect(readFileSync(join(site, 'index.json'), 'utf8')).not.toContain('pr/5');

    const before = readFileSync(join(site, 'index.json'), 'utf8');
    const landing = statSync(join(site, 'index.html')).mtimeMs;
    expect(await removePullRequest(site, 8, 'o/r', deps, io(), removePaths)).toBe(false);
    expect(readFileSync(join(site, 'index.json'), 'utf8')).toBe(before);
    expect(statSync(join(site, 'index.html')).mtimeMs).toBe(landing);

    // a folder left without an index entry is still removed
    mkdirSync(join(site, 'pr/9/runs/1'), { recursive: true });
    expect(await removePullRequest(site, 9, 'o/r', deps, io(), removePaths)).toBe(true);
    expect(existsSync(join(site, 'pr/9'))).toBe(false);
  });

  test('removes through the given remove function', async () => {
    await publish(await runReport('p', 7), 7);
    const removed: string[][] = [];
    await removePullRequest(site, 5, 'o/r', deps, io(), async (_s, paths) => void removed.push(paths));
    expect(removed.flat()).toContain('pr/5');
  });
});
