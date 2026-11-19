import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { resolveDeps } from '../../../src/api/report.js';
import {
  addRunReport,
  ensureMainReport,
  removeRun,
  replaceRunPartitions,
  runSource,
  runSourcePrefix,
  sourceRun,
} from '../../../src/cli/ci/main-report.js';
import { readRunManifest, totalsAndRange } from '../../../src/cli/ci/run-report.js';
import type { ManifestV4 } from '../../../src/format/manifest.js';
import { TABLES } from '../../../src/format/parquet/columns.js';
import { openSession, type WriterDeps } from '../../../src/writer/session.js';
import { spansOnlyRequest } from '../../../test-support/format4-fixture.js';
import { fakeViewerAssets, testConfig } from '../../../test-support/writer-deps.js';

const NOW = '2026-11-10T12:00:00.000Z';
const BASE = '../../assets/';
let deps: WriterDeps;
let root: string;

beforeAll(async () => {
  deps = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' });
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'main-report-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A closed site-format report of `n` spans in `<root>/<name>`. */
async function runReport(name: string, n: number): Promise<string> {
  const out = join(root, name);
  const session = await openSession(deps, {
    out,
    config: testConfig({ writer: { format: 'site' } }),
    mode: 'replace',
  });
  await session.add(spansOnlyRequest(n), 'fixture');
  await session.flush();
  await session.close();
  return out;
}

const manifestOf = async (dir: string): Promise<ManifestV4> => {
  const m = await readRunManifest(deps.fs, dir);
  if (m === null) throw new Error('no manifest');
  return m;
};
const filesOf = (m: ManifestV4, source: string): string[] =>
  m.partitions
    .filter((p) => p.source === source)
    .flatMap((p) => TABLES.flatMap((t) => p.files[t]?.path ?? []));

describe('run sources', () => {
  test('runSource / sourceRun round-trip; sourceRun rejects other prefixes', () => {
    expect(runSource(12345, 2)).toBe('run:12345#2');
    expect(runSourcePrefix(12345)).toBe('run:12345#');
    expect(sourceRun('run:12345#2')).toEqual({ runId: 12345, attempt: 2 });
    expect(sourceRun('job:7#compact:3')).toBeUndefined();
    expect(sourceRun('run:x#1')).toBeUndefined();
    expect(sourceRun('run:1')).toBeUndefined();
  });
});

describe('ensureMainReport', () => {
  test('creates a complete format-8 site report with the config, then only patches what differs', async () => {
    const dir = join(root, 'main');
    const config = testConfig({ title: 'CI' });
    const first = await ensureMainReport(deps, dir, config, { now: NOW, assetsBase: BASE });
    expect([...first].sort()).toEqual(['.nojekyll', 'data/manifest.js', 'index.html']);
    const m = await manifestOf(dir);
    expect(m.formatVersion).toBe(8);
    expect(m.complete).toBe(true);
    expect(m.engine.assetsBase).toBe(BASE);
    expect(m.config?.dashboards).toEqual(config.dashboards);
    expect(await ensureMainReport(deps, dir, config, { now: NOW, assetsBase: BASE })).toEqual([]);
    const other = testConfig({ title: 'CI', viewer: { theme: 'dark' } });
    expect(await ensureMainReport(deps, dir, other, { now: NOW, assetsBase: BASE })).toEqual([
      'data/manifest.js',
    ]);
    expect((await manifestOf(dir)).config?.viewer.theme).toBe('dark');
  });
});

describe('run partitions', () => {
  const setup = async (): Promise<{ main: string; one: string; two: string }> => {
    const main = join(root, 'main');
    await ensureMainReport(deps, main, testConfig(), { now: NOW, assetsBase: BASE });
    const one = await runReport('one', 4);
    const two = await runReport('two', 6);
    return { main, one, two };
  };

  test('addRunReport copies the partitions in under run:<id>#<attempt>, renumbered from next, touching no other partition', async () => {
    const { main, one, two } = await setup();
    await addRunReport(deps, main, one, { runId: 1, attempt: 1 }, { now: NOW, next: 0 });
    const before = await manifestOf(main);
    const res = await addRunReport(deps, main, two, { runId: 2, attempt: 1 }, { now: NOW, next: 5 });
    const after = await manifestOf(main);
    const added = after.partitions.filter((p) => p.source === 'run:2#1');
    expect(added.map((p) => p.n)).toEqual([5]);
    expect(after.partitions.find((p) => p.source === 'run:1#1')).toEqual(
      before.partitions.find((p) => p.source === 'run:1#1'),
    );
    expect(after.totals.spans).toBe(10);
    expect(after.complete).toBe(true);
    expect(after.updatedAt).toBe(NOW);
    const src = await manifestOf(two);
    // the range is the files' own times, from both runs
    expect(after.range).toEqual(totalsAndRange([...before.partitions, ...src.partitions]).range);
    expect(res.next).toBe(6);
    expect(res.dropped).toEqual([]);
    for (const [i, p] of src.partitions.entries()) {
      for (const t of TABLES) {
        const f = p.files[t];
        const g = added[i]?.files[t];
        if (f === undefined) continue;
        expect(g).toBeDefined();
        expect(readFileSync(join(main, g?.path ?? ''))).toEqual(readFileSync(join(two, f.path)));
        expect(res.written).toContain(g?.path);
      }
    }
    expect(res.written).toEqual(expect.arrayContaining(['data/manifest.js', 'index.html', '.nojekyll']));
  });

  test('a higher attempt replaces the earlier one: its partitions are dropped and listed, numbers never reused', async () => {
    const { main, two } = await setup();
    await addRunReport(deps, main, two, { runId: 2, attempt: 1 }, { now: NOW, next: 5 });
    const firstFiles = filesOf(await manifestOf(main), 'run:2#1');
    expect(firstFiles.length).toBeGreaterThan(0);
    const res = await addRunReport(deps, main, two, { runId: 2, attempt: 2 }, { now: NOW, next: 0 });
    const m = await manifestOf(main);
    expect(m.partitions.map((p) => p.source)).toEqual(['run:2#2']);
    expect(m.partitions.map((p) => p.n)).toEqual([6]);
    expect(res.dropped.sort()).toEqual([...firstFiles].sort());
    for (const f of firstFiles) expect(existsSync(join(main, f))).toBe(true);
    expect(res.next).toBe(7);
  });

  test('removeRun drops every partition of the run and nothing else', async () => {
    const { main, one, two } = await setup();
    await addRunReport(deps, main, one, { runId: 1, attempt: 1 }, { now: NOW, next: 0 });
    await addRunReport(deps, main, two, { runId: 2, attempt: 1 }, { now: NOW, next: 1 });
    await addRunReport(deps, main, two, { runId: 2, attempt: 2 }, { now: NOW, next: 2 });
    const keep = filesOf(await manifestOf(main), 'run:1#1');
    const res = await removeRun(deps, main, 2, { now: NOW });
    const m = await manifestOf(main);
    expect(m.partitions.map((p) => p.source)).toEqual(['run:1#1']);
    expect(m.totals.spans).toBe(4);
    expect(res.dropped.length).toBeGreaterThan(0);
    expect(res.dropped.filter((f) => keep.includes(f))).toEqual([]);
  });

  test('replaceRunPartitions throws invalid-report without a main manifest or a source manifest', async () => {
    const { main, two } = await setup();
    await expect(
      addRunReport(deps, join(root, 'nowhere'), two, { runId: 2, attempt: 1 }, { now: NOW, next: 0 }),
    ).rejects.toMatchObject({ code: 'invalid-report' });
    await expect(
      addRunReport(deps, main, join(root, 'empty'), { runId: 2, attempt: 1 }, { now: NOW, next: 0 }),
    ).rejects.toMatchObject({ code: 'invalid-report' });
    await expect(
      replaceRunPartitions(
        deps,
        join(root, 'nowhere'),
        null,
        { runId: 2, attempt: 0 },
        { now: NOW, next: 0 },
      ),
    ).rejects.toMatchObject({ code: 'invalid-report' });
  });
});
