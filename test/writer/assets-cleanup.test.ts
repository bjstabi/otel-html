import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ConfigInput } from '../../src/config/schema.js';
import { engineAssetNames } from '../../src/writer/engine-assets.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { openSession } from '../../src/writer/session.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { spansRequest } from './helpers.js';

const OUT = 'r';
type Writer = NonNullable<ConfigInput['writer']>;

async function session(w: TestWriter, writer: Writer, mode: 'replace' | 'append' = 'replace') {
  const s = await openSession(w.deps, { out: OUT, config: testConfig({ writer }), mode });
  await s.add(otlp(spansRequest(1)), 'a.json');
  await s.close();
}

/** Every name directly under assets/, subfolders as their folder name. */
const assetNames = (w: TestWriter): string[] =>
  [
    ...new Set(
      [...w.fs.snapshot().keys()]
        .filter((k) => k.startsWith(`${OUT}/assets/`))
        .map((k) => k.slice(`${OUT}/assets/`.length).split('/')[0] ?? ''),
    ),
  ].sort();

const viewer = ['viewer.abc123.css', 'viewer.abc123.js'];

async function replaceOver(first: Writer, second: Writer): Promise<string[]> {
  const w = createTestWriter();
  await session(w, first);
  await w.fs.writeBytes(`${OUT}/assets/v1/keep.js`, new Uint8Array(1));
  await session(w, second);
  expect(w.fs.snapshot().has(`${OUT}/assets/v1/keep.js`)).toBe(true);
  return assetNames(w).filter((n) => n !== 'v1');
}

describe('--replace leaves no dead files in the report assets', () => {
  const shared = '../../assets/0.3.0/';
  test('local to a shared site base: nothing of its own remains', async () => {
    expect(await replaceOver({ format: 'local' }, { format: 'site', assetsBase: shared })).toEqual([]);
  });
  test('site with its own assets to a shared site base', async () => {
    expect(await replaceOver({ format: 'site' }, { format: 'site', assetsBase: shared })).toEqual([]);
  });
  test('local to chunks: the viewer files stay, the engine files go', async () => {
    expect(await replaceOver({ format: 'local' }, { format: 'chunks' })).toEqual(viewer);
  });
  test('local to site with its own assets: only the site engine files', async () => {
    expect(await replaceOver({ format: 'local' }, { format: 'site' })).toEqual(
      [...viewer, ...engineAssetNames('site')].sort(),
    );
  });
});

describe('an in-report base named like a viewer file', () => {
  test('assets/viewer.0.3.0/ survives repeated appends', async () => {
    const w = createTestWriter();
    const writer = { format: 'site', assetsBase: 'assets/viewer.0.3.0/' } as const;
    await session(w, writer);
    await w.fs.writeBytes(`${OUT}/assets/viewer.0.3.0/viewer.x.js`, new Uint8Array(1));
    await session(w, writer, 'append');
    await session(w, writer, 'append');
    expect(w.fs.snapshot().has(`${OUT}/assets/viewer.0.3.0/viewer.x.js`)).toBe(true);
  });
});

// Links need no privilege on POSIX; on Windows creating one can, so those runs are skipped there.
describe.skipIf(process.platform === 'win32')('links out of the report are never followed', () => {
  async function onDisk(setup: (root: string, out: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'assets-link-'));
    try {
      const out = join(root, 'r');
      const deps = { ...createTestWriter().deps, fs: createNodeFileSystem() };
      const writer = { format: 'site', assetsBase: '../../assets/0.3.0/' } as const;
      const first = await openSession(deps, { out, config: testConfig({ writer }), mode: 'replace' });
      await first.add(otlp(spansRequest(1)), 'a.json');
      await first.close();
      setup(root, out);
      const second = await openSession(deps, { out, config: testConfig({ writer }), mode: 'append' });
      await second.add(otlp(spansRequest(1, 0, 5)), 'b.json');
      await second.close();
      return root;
    } catch (e) {
      rmSync(root, { recursive: true, force: true });
      throw e;
    }
  }
  const engine = engineAssetNames('site')[0] ?? '';

  test('a symlinked assets/ leaves the folder it points at untouched', async () => {
    const root = await onDisk((r, out) => {
      mkdirSync(join(r, 'shared'));
      for (const n of ['viewer.abc.js', engine]) writeFileSync(join(r, 'shared', n), 'x');
      symlinkSync(join(r, 'shared'), join(out, 'assets'), 'dir');
    });
    try {
      expect(readdirSync(join(root, 'shared')).sort()).toEqual(['viewer.abc.js', engine].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a symlinked file inside the report assets is skipped', async () => {
    const root = await onDisk((r, out) => {
      writeFileSync(join(r, 'target.txt'), 'x');
      mkdirSync(join(out, 'assets'), { recursive: true });
      symlinkSync(join(r, 'target.txt'), join(out, 'assets', 'viewer.link.js'));
    });
    try {
      expect(readdirSync(join(root, 'r', 'assets'))).toEqual(['viewer.link.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
