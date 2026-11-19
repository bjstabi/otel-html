import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { resolveDeps } from '../../../src/api/report.js';
import { runSource } from '../../../src/cli/ci/main-report.js';
import { mergeWithConfig } from '../../../src/cli/ci/publish-io.js';
import { readRunManifest, writeRunReport } from '../../../src/cli/ci/run-report.js';
import { IN_PROGRESS, type SiteIndex, type SiteRun } from '../../../src/cli/ci/site.js';
import { migrateToOneReport } from '../../../src/cli/ci/site-migrate.js';
import type { ManifestV4 } from '../../../src/format/manifest.js';
import type { WriterDeps } from '../../../src/writer/session.js';
import { writeCiRunReport } from '../../../test-support/ci-run-fixture.js';
import { fakeViewerAssets } from '../../../test-support/writer-deps.js';

const START = Date.parse('2026-10-01T10:00:00Z');
const ONE = 'branch/main';
let deps: WriterDeps;
let root: string;
let site: string;
let warnings: string[];
let removed: string[];

beforeAll(async () => {
  deps = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' });
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'site-migrate-'));
  site = join(root, 'site');
  mkdirSync(site);
  warnings = [];
  removed = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const legacyRun = (runId: number, attempt: number, reportPath: string, conclusion = 'success'): SiteRun => ({
  runId,
  attempt,
  conclusion,
  headSha: 'abc',
  headBranch: 'main',
  completedAt: '2026-10-01T10:05:00Z',
  runUrl: `https://github.com/o/r/actions/runs/${runId}`,
  reportPath,
});

/** The rolling report as it was: per-run reports merged into `branch/main`, so its partitions are `merge:` sources. */
async function rolling(runs: { runId: number; attempt: number }[]): Promise<void> {
  const inputs: string[] = [];
  for (const r of runs) {
    const dir = join(root, `run-${r.runId}`);
    await writeCiRunReport(deps, dir, { repository: 'o/r', ...r, startMs: START + r.runId });
    inputs.push(dir);
  }
  const merge = mergeWithConfig(deps, undefined, {
    format: 'site',
    assetsBase: '../../assets/',
    compact: true,
  });
  await merge(inputs, join(site, ONE), false);
}

const migrate = (index: SiteIndex) =>
  migrateToOneReport({
    site,
    index,
    reportPath: ONE,
    deps,
    warn: (m) => warnings.push(m),
    remove: async (_s, paths) => {
      removed.push(...paths);
    },
  });

const manifest = async (): Promise<ManifestV4> => {
  const m = await readRunManifest(deps.fs, join(site, ONE));
  if (m === null) throw new Error('no manifest');
  return m;
};

describe('migrateToOneReport', () => {
  test('merge: partitions are renamed to run:<id>#<attempt> by their cicd run row; runs get detail full and the one reportPath', async () => {
    await rolling([
      { runId: 1, attempt: 1 },
      { runId: 2, attempt: 2 },
    ]);
    expect((await manifest()).partitions.every((p) => p.source.startsWith('merge:'))).toBe(true);
    const index: SiteIndex = {
      version: 1,
      channels: {
        [ONE]: {
          kind: 'branch',
          title: 'main',
          headBranch: 'main',
          runs: [legacyRun(2, 2, `${ONE}/runs/2`), legacyRun(1, 1, `${ONE}/runs/1`)],
        },
      },
    };
    const before = await manifest();
    const r = await migrate(index);
    expect(r.changed).toBe(true);
    const after = await manifest();
    expect(after.partitions.map((p) => p.source).sort()).toEqual([runSource(1, 1), runSource(2, 2)]);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.totals).toEqual(before.totals);
    expect(r.index.channels[ONE]?.runs.map((x) => [x.reportPath, x.detail])).toEqual([
      [ONE, 'full'],
      [ONE, 'full'],
    ]);
    expect(removed).toEqual([]);
  });

  test('a merge: partition with no cicd run row, or naming an unindexed run, is dropped through remove with a warning', async () => {
    await rolling([
      { runId: 1, attempt: 1 },
      { runId: 2, attempt: 1 },
    ]);
    const m = await manifest();
    const [first, second] = m.partitions;
    if (first === undefined || second === undefined) throw new Error('expected two partitions');
    const noCicd = { ...first, files: { ...first.files } };
    delete noCicd.files.cicd;
    await writeRunReport(deps, join(site, ONE), { ...m, partitions: [noCicd, second] });
    const index: SiteIndex = {
      version: 1,
      channels: {
        [ONE]: {
          kind: 'branch',
          title: 'main',
          headBranch: 'main',
          runs: [legacyRun(1, 1, `${ONE}/runs/1`)],
        },
      },
    };
    const r = await migrate(index);
    expect(r.changed).toBe(true);
    // partition one has no cicd file; partition two names run 2, which is not indexed
    expect((await manifest()).partitions).toEqual([]);
    expect(warnings).toHaveLength(2);
    const files = [noCicd, second].flatMap((p) => Object.values(p.files).map((f) => `${ONE}/${f.path}`));
    expect(removed).toEqual(expect.arrayContaining(files));
    expect(existsSync(join(site, files[0] ?? ''))).toBe(true);
  });

  test('run folders and pr folders go through remove; an in-progress staging folder stays', async () => {
    for (const p of ['branch/main/runs/1', 'branch/main/runs/9', 'pr/362', 'pr/363'])
      mkdirSync(join(site, p), { recursive: true });
    const index: SiteIndex = {
      version: 1,
      channels: {
        [ONE]: {
          kind: 'branch',
          title: 'main',
          headBranch: 'main',
          runs: [legacyRun(9, 1, `${ONE}/runs/9`, IN_PROGRESS), legacyRun(1, 1, `${ONE}/runs/1`)],
        },
      },
    };
    const r = await migrate(index);
    expect(r.changed).toBe(true);
    expect(removed.sort()).toEqual(['branch/main/runs/1', 'pr/362', 'pr/363']);
  });

  test('a second call changes nothing', async () => {
    await rolling([{ runId: 1, attempt: 1 }]);
    mkdirSync(join(site, 'pr/362'), { recursive: true });
    const index: SiteIndex = {
      version: 1,
      channels: {
        [ONE]: {
          kind: 'branch',
          title: 'main',
          headBranch: 'main',
          runs: [legacyRun(1, 1, `${ONE}/runs/1`)],
        },
      },
    };
    const first = await migrate(index);
    expect(first.changed).toBe(true);
    removed = [];
    mkdirSync(join(site, 'pr/362'), { recursive: true });
    rmSync(join(site, 'pr'), { recursive: true });
    const second = await migrate(first.index);
    expect(second.changed).toBe(false);
    expect(second.index).toEqual(first.index);
    expect(removed).toEqual([]);
  });

  test('a flush: partition whose cicd run row names an indexed run is renamed to run:<id>#<attempt>', async () => {
    await rolling([{ runId: 1, attempt: 3 }]);
    const m = await manifest();
    const [p] = m.partitions;
    if (p === undefined) throw new Error('expected a partition');
    await writeRunReport(deps, join(site, ONE), { ...m, partitions: [{ ...p, source: 'flush:5' }] });
    const index: SiteIndex = {
      version: 1,
      channels: {
        [ONE]: {
          kind: 'branch',
          title: 'main',
          headBranch: 'main',
          runs: [legacyRun(1, 3, `${ONE}/runs/1`)],
        },
      },
    };
    await migrate(index);
    expect((await manifest()).partitions.map((x) => x.source)).toEqual([runSource(1, 3)]);
    expect(removed).toEqual([]);
  });

  test('an unreadable cicd file keeps its partition untouched with one warning', async () => {
    await rolling([
      { runId: 1, attempt: 1 },
      { runId: 2, attempt: 1 },
    ]);
    const m = await manifest();
    const bad = m.partitions[0];
    const cicd = bad?.files.cicd;
    if (bad === undefined || cicd === undefined) throw new Error('expected a cicd file');
    writeFileSync(join(site, ONE, cicd.path), 'not parquet at all');
    const index: SiteIndex = {
      version: 1,
      channels: {
        [ONE]: {
          kind: 'branch',
          title: 'main',
          headBranch: 'main',
          runs: [legacyRun(2, 1, `${ONE}/runs/2`), legacyRun(1, 1, `${ONE}/runs/1`)],
        },
      },
    };
    await migrate(index);
    const sources = (await manifest()).partitions.map((x) => x.source);
    expect(sources).toContain(bad.source);
    expect(sources.filter((s) => s.startsWith('run:'))).toHaveLength(1);
    expect(removed).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(cicd.path);
  });
});
