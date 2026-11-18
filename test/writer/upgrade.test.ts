import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCli } from '../../src/cli/program.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isPartitioned, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { oldFormatMessage } from '../../src/format/version.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { openSession } from '../../src/writer/session.js';
import { upgradeReport } from '../../src/writer/upgrade.js';
import { createProcess, createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';
import { spansRequest } from './helpers.js';

const FIXTURE = join(import.meta.dirname, '../../fixtures/reports/format-2');

function copyReport(fixture = FIXTURE): string {
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-'));
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

/** A format-4 `site` report on the real file system. */
async function formatFourReport(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-v4-'));
  const w = createTestWriter();
  const s = await openSession(
    { ...w.deps, fs: createNodeFileSystem() },
    { out: dir, config: testConfig({ writer: { format: 'site' } }), mode: 'replace' },
  );
  await s.add(otlp(spansRequest(2)), 'in.json');
  await s.close();
  return dir;
}

function readManifest(dir: string): unknown {
  return reviveDataJson(unwrapDataFile(readFileSync(join(dir, 'data/manifest.js'), 'utf8'), MANIFEST_KEY));
}

function hashTree(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isSymbolicLink()) out[r] = `-> ${readlinkSync(join(dir, r))}`;
    else if (e.isDirectory()) Object.assign(out, hashTree(dir, r));
    else
      out[r] = createHash('sha256')
        .update(readFileSync(join(dir, r)))
        .digest('hex');
  }
  return out;
}

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

function deps() {
  const w = createTestWriter();
  return { ...w.deps, fs: createNodeFileSystem() };
}

describe('upgradeReport', () => {
  test('rewrites the viewer, drops stale viewer files and leaves data byte-identical', async () => {
    const dir = await formatFourReport();
    writeFileSync(join(dir, 'assets/viewer.old.js'), 'old');
    writeFileSync(join(dir, 'index.html'), '<html>old</html>');
    const before = hashTree(dir, 'data');
    const r = await upgradeReport(deps(), dir);
    expect(r.formatVersion).toBe(8);
    expect(hashTree(dir, 'data')).toEqual(before);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('assets/viewer.abc123.js');
    expect(readdirSync(join(dir, 'assets'))).toContain('viewer.abc123.js');
    expect(readdirSync(join(dir, 'assets'))).not.toContain('viewer.old.js');
    expect(readdirSync(join(dir, 'data/state'))).not.toContain('lock.json');
  });

  test.each([
    ['format-2', 2],
    ['format-3', 3],
  ])('a %s report is a usage error with the D12 message, and nothing is written', async (name, version) => {
    const dir = copyReport(join(import.meta.dirname, `../../fixtures/reports/${name}`));
    const before = hashTree(dir);
    const e = await failure(upgradeReport(deps(), dir));
    expect(e.code).toBe('usage');
    expect(e.message).toBe(oldFormatMessage(version));
    expect(hashTree(dir)).toEqual(before);
  });

  // An untrusted report may carry symlinks at the viewer's paths. Symlinks on Windows need a privilege.
  test.skipIf(process.platform === 'win32')(
    'a symlinked asset is replaced, not written through',
    async () => {
      const dir = await formatFourReport();
      const outside = join(mkdtempSync(join(tmpdir(), 'upgrade-outside-')), 'precious');
      writeFileSync(outside, 'precious');
      rmSync(join(dir, 'assets/viewer.abc123.js'), { force: true });
      symlinkSync(outside, join(dir, 'assets/viewer.abc123.js'));
      await upgradeReport(deps(), dir);
      expect(readFileSync(outside, 'utf8')).toBe('precious');
      expect(lstatSync(join(dir, 'assets/viewer.abc123.js')).isSymbolicLink()).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'an assets folder that links out of the report is refused',
    async () => {
      const dir = await formatFourReport();
      const outside = mkdtempSync(join(tmpdir(), 'upgrade-outside-'));
      rmSync(join(dir, 'assets'), { recursive: true });
      symlinkSync(outside, join(dir, 'assets'));
      const before = hashTree(dir);
      const e = await failure(upgradeReport(deps(), dir));
      expect(e.code).toBe('invalid-report');
      expect(e.hint).toContain(`upgrade ${dir} --assets-base <shared base>`);
      expect(e.hint).toContain('replace the assets link with a real folder');
      expect(e.hint).toContain("this version's viewer files");
      expect(e.hint).toContain('flat folder');
      expect(readdirSync(outside)).toEqual([]);
      expect(hashTree(dir)).toEqual(before);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a shared --assets-base upgrades a report whose assets folder links out, writing nothing through the link',
    async () => {
      const dir = await formatFourReport();
      const outside = mkdtempSync(join(tmpdir(), 'upgrade-outside-'));
      // Content the writer would not produce: a write of the viewer file through the link changes the hash,
      // and so does a new file. The base is a folder of the link's target, reached through the report's link.
      writeFileSync(join(outside, 'viewer.abc123.js'), 'the publisher copy, not ours');
      writeFileSync(join(outside, 'viewer.old.js'), 'old');
      mkdirSync(join(outside, '0.0.0'));
      writeFileSync(join(outside, '0.0.0/viewer.abc123.js'), 'shared viewer');
      rmSync(join(dir, 'assets'), { recursive: true });
      symlinkSync(outside, join(dir, 'assets'));
      const targetBefore = hashTree(outside);
      const base = 'assets/0.0.0/';
      const w = createTestWriter();
      const r = await upgradeReport({ ...w.deps, fs: createNodeFileSystem() }, dir, { assetsBase: base });
      expect(r).toMatchObject({ formatVersion: 8 });
      expect(w.logs.filter((l) => l.level === 'warn')).toEqual([]);
      expect(hashTree(outside)).toEqual(targetBefore);
      expect(readlinkSync(join(dir, 'assets'))).toBe(outside);
      expect((readManifest(dir) as { engine: { assetsBase: string } }).engine.assetsBase).toBe(base);
      expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(base);
      // An append on the same base writes nothing through the link either.
      const s = await openSession(
        { ...createTestWriter().deps, fs: createNodeFileSystem() },
        { out: dir, config: testConfig({ writer: { format: 'site', assetsBase: base } }), mode: 'append' },
      );
      await s.add(otlp(spansRequest(1, 0, 50)), 'more.json');
      await s.close();
      expect(hashTree(outside)).toEqual(targetBefore);
      expect(readlinkSync(join(dir, 'assets'))).toBe(outside);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a shared base that holds no viewer files on this disk is a warning, not a refusal',
    async () => {
      const dir = await formatFourReport();
      const w = createTestWriter();
      await upgradeReport({ ...w.deps, fs: createNodeFileSystem() }, dir, { assetsBase: 'assets/9.9.9/' });
      const warns = w.logs.filter((l) => l.level === 'warn');
      expect(warns).toHaveLength(1);
      expect(warns[0]?.msg).toContain('assets/9.9.9/');
      expect(warns[0]?.msg).toContain('viewer.abc123.js');
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a site base outside the report is not checked: it is deployed beside the report, not on this disk',
    async () => {
      const dir = await formatFourReport();
      const w = createTestWriter();
      await upgradeReport({ ...w.deps, fs: createNodeFileSystem() }, dir, {
        assetsBase: '../../assets/9.9.9/',
      });
      expect(w.logs.filter((l) => l.level === 'warn')).toEqual([]);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'the no-base hint of a shared report with a linked assets folder does not offer a copy into assets/',
    async () => {
      const dir = await formatFourReport();
      await upgradeReport(deps(), dir, { assetsBase: 'assets/9.9.9/' });
      const outside = mkdtempSync(join(tmpdir(), 'upgrade-outside-'));
      rmSync(join(dir, 'assets'), { recursive: true });
      symlinkSync(outside, join(dir, 'assets'));
      const none = await failure(upgradeReport(deps(), dir));
      expect(none.code).toBe('usage');
      expect(none.hint).not.toContain('--assets-base assets/ to copy');
      // Asking for the default base on a report that records a shared one points at the recorded base.
      const back = await failure(upgradeReport(deps(), dir, { assetsBase: 'assets/' }));
      expect(back.code).toBe('invalid-report');
      expect(back.hint).toContain('assets/9.9.9/');
      expect(back.hint).not.toContain('upgrade ');
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a default-base upgrade of a report whose assets folder links out is still refused',
    async () => {
      const dir = await formatFourReport();
      const outside = mkdtempSync(join(tmpdir(), 'upgrade-outside-'));
      rmSync(join(dir, 'assets'), { recursive: true });
      symlinkSync(outside, join(dir, 'assets'));
      const e = await failure(upgradeReport(deps(), dir, { assetsBase: 'assets/' }));
      expect(e.code).toBe('invalid-report');
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  test('a folder with no report is a usage error and nothing is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'upgrade-empty-'));
    const e = await failure(upgradeReport(deps(), dir));
    expect(e.code).toBe('usage');
    expect(readdirSync(dir)).toEqual([]);
  });

  test('a report another writer has open is a usage error and nothing is written', async () => {
    const dir = await formatFourReport();
    const lock = JSON.stringify({ pid: 4242, hostname: 'host-a', startedAt: 'now' });
    writeFileSync(join(dir, 'data/state/lock.json'), lock);
    const before = hashTree(dir);
    const e = await failure(upgradeReport(deps(), dir));
    expect(e.code).toBe('usage');
    expect(e.hint).toBe('another otel-html has the report open');
    expect(hashTree(dir)).toEqual(before);
  });
});

describe('upgrade of the frozen format-5 report', () => {
  const FORMAT5 = join(import.meta.dirname, '../../fixtures/reports/format-5');

  test('5 to 6 rewrites the manifest only: no epoch on disk, every partition file unchanged, every row reads', async () => {
    const dir = copyReport(FORMAT5);
    const partitions = hashTree(dir, 'data/partitions');
    const state = hashTree(dir, 'data/state');
    const before = parseAnyManifest(readManifest(dir));
    if (!isPartitioned(before)) throw new Error('not a partition manifest');
    const r = await upgradeReport(deps(), dir);
    expect(r.formatVersion).toBe(8);
    expect(hashTree(dir, 'data/partitions')).toEqual(partitions);
    expect(hashTree(dir, 'data/state')).toEqual(state);
    const raw = readManifest(dir);
    expect(raw).toMatchObject({ formatVersion: 8 });
    expect(raw).not.toHaveProperty('epochUnixNano');
    const after = parseAnyManifest(raw);
    if (!isPartitioned(after)) throw new Error('not a partition manifest');
    expect(after.partitions).toEqual(before.partitions);
    expect(after.totals).toEqual(before.totals);
    expect(after.epochUnixNano).toBe(after.range?.start); // a reader's derived anchor
    let traces = 0;
    for (const p of after.partitions) {
      const file = p.files.traces;
      if (file !== undefined) traces += decodeTable('traces', readFileSync(join(dir, file.path))).length;
    }
    expect(traces).toBeGreaterThan(0);
  });
});

describe('upgrade of the frozen format-7 report', () => {
  const FORMAT7 = join(import.meta.dirname, '../../fixtures/reports/format-7');

  test('7 to 8 rewrites the manifest version only: no partition byte changes and no cicd flag is set', async () => {
    const dir = copyReport(FORMAT7);
    const partitions = hashTree(dir, 'data/partitions');
    const before = parseAnyManifest(readManifest(dir));
    if (!isPartitioned(before)) throw new Error('not a partition manifest');
    expect(before.formatVersion).toBe(7);
    const r = await upgradeReport(deps(), dir);
    expect(r.formatVersion).toBe(8);
    expect(hashTree(dir, 'data/partitions')).toEqual(partitions);
    const after = parseAnyManifest(readManifest(dir));
    if (!isPartitioned(after)) throw new Error('not a partition manifest');
    expect(after.formatVersion).toBe(8);
    expect(after.partitions).toEqual(before.partitions);
    for (const p of after.partitions) {
      expect(p.cicd).toBeUndefined();
      expect(p.files.cicd).toBeUndefined();
    }
  });
});

describe('upgrade of the frozen format-6 report', () => {
  const FORMAT6 = join(import.meta.dirname, '../../fixtures/reports/format-6');

  test('6 to 7 rewrites the manifest version only: every partition file unchanged', async () => {
    const dir = copyReport(FORMAT6);
    const partitions = hashTree(dir, 'data/partitions');
    const before = parseAnyManifest(readManifest(dir));
    if (!isPartitioned(before)) throw new Error('not a partition manifest');
    expect(before.formatVersion).toBe(6);
    const r = await upgradeReport(deps(), dir);
    expect(r.formatVersion).toBe(8);
    expect(hashTree(dir, 'data/partitions')).toEqual(partitions);
    const raw = readManifest(dir);
    expect(raw).toMatchObject({ formatVersion: 8 });
    expect(raw).not.toHaveProperty('epochUnixNano');
    const after = parseAnyManifest(raw);
    if (!isPartitioned(after)) throw new Error('not a partition manifest');
    expect(after.partitions).toEqual(before.partitions);
  });
});

describe('otel-html upgrade', () => {
  async function run(argv: string[], dir: string): Promise<{ code: number; stdout: string }> {
    let stdout = '';
    const w = createTestWriter({ process: createProcess() });
    const code = await runCli(
      argv.map((a) => (a === '$dir' ? dir : a)),
      {
        stdout: (s) => {
          stdout += s;
        },
        stderr: () => undefined,
        env: {},
        cwd: '/work',
        signals: { on: () => () => undefined },
        spawn: () => {
          throw new Error('no spawn');
        },
      },
      { ...w.deps, fs: createNodeFileSystem() },
    );
    return { code, stdout };
  }

  test('exits 2 on a folder with no report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'upgrade-cli-'));
    expect((await run(['upgrade', '$dir'], dir)).code).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('prints the viewer and format versions', async () => {
    const dir = await formatFourReport();
    const r = await run(['upgrade', '$dir'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^upgraded .+: viewer \d+\.\d+\.\d+\S*, format 8\n$/);
  });

  test('a format 3 report exits 2 and leaves it alone', async () => {
    const dir = copyReport(join(import.meta.dirname, '../../fixtures/reports/format-3'));
    const before = hashTree(dir);
    expect((await run(['upgrade', '$dir'], dir)).code).toBe(2);
    expect(hashTree(dir)).toEqual(before);
  });

  test('--format chunks is rejected by the option choices', async () => {
    const dir = await formatFourReport();
    expect((await run(['upgrade', '$dir', '--format', 'chunks'], dir)).code).toBe(2);
  });
});
