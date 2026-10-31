import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCli } from '../../src/cli/program.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { upgradeReport } from '../../src/writer/upgrade.js';
import { createProcess, createTestWriter } from '../../test-support/writer-deps.js';

const FIXTURE = join(import.meta.dirname, '../../fixtures/reports/format-2');

function copyReport(): string {
  const dir = mkdtempSync(join(tmpdir(), 'upgrade-'));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
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
  test('rewrites the viewer, drops stale assets and leaves data byte-identical', async () => {
    const dir = copyReport();
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets/old.js'), 'old');
    writeFileSync(join(dir, 'index.html'), '<html>old</html>');
    const before = hashTree(dir, 'data');
    const r = await upgradeReport(deps(), dir);
    expect(r.formatVersion).toBe(2);
    expect(hashTree(dir, 'data')).toEqual(before);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('assets/viewer.abc123.js');
    expect(readdirSync(join(dir, 'assets')).sort()).toEqual(['viewer.abc123.css', 'viewer.abc123.js']);
    expect(readdirSync(join(dir, 'data/state'))).not.toContain('lock.json');
  });

  // An untrusted report may carry symlinks at the viewer's paths. Symlinks on Windows need a privilege.
  test.skipIf(process.platform === 'win32')(
    'a symlinked asset is replaced, not written through',
    async () => {
      const dir = copyReport();
      const outside = join(mkdtempSync(join(tmpdir(), 'upgrade-outside-')), 'precious');
      writeFileSync(outside, 'precious');
      mkdirSync(join(dir, 'assets'));
      symlinkSync(outside, join(dir, 'assets/viewer.abc123.js'));
      await upgradeReport(deps(), dir);
      expect(readFileSync(outside, 'utf8')).toBe('precious');
      expect(lstatSync(join(dir, 'assets/viewer.abc123.js')).isSymbolicLink()).toBe(false);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'an assets folder that links out of the report is refused',
    async () => {
      const dir = copyReport();
      const outside = mkdtempSync(join(tmpdir(), 'upgrade-outside-'));
      symlinkSync(outside, join(dir, 'assets'));
      const before = hashTree(dir);
      const e = await failure(upgradeReport(deps(), dir));
      expect(e.code).toBe('invalid-report');
      expect(readdirSync(outside)).toEqual([]);
      expect(hashTree(dir)).toEqual(before);
    },
  );

  test('a folder with no report is a usage error and nothing is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'upgrade-empty-'));
    const e = await failure(upgradeReport(deps(), dir));
    expect(e.code).toBe('usage');
    expect(readdirSync(dir)).toEqual([]);
  });

  test('a report another writer has open is a usage error and nothing is written', async () => {
    const dir = copyReport();
    const lock = JSON.stringify({ pid: 4242, hostname: 'host-a', startedAt: 'now' });
    writeFileSync(join(dir, 'data/state/lock.json'), lock);
    const before = hashTree(dir);
    const e = await failure(upgradeReport(deps(), dir));
    expect(e.code).toBe('usage');
    expect(e.hint).toBe('another otel-html has the report open');
    expect(hashTree(dir)).toEqual(before);
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
    const dir = copyReport();
    const r = await run(['upgrade', '$dir'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^upgraded .+: viewer \d+\.\d+\.\d+\S*, format 2\n$/);
  });
});
