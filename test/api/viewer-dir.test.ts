import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { packageDirViewerAssets } from '../../src/api/viewer-dir.js';
import { OtelHtmlError } from '../../src/model/errors.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'otel-html-viewer-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const urlOf = (dir: string): URL => pathToFileURL(`${dir}/`);

async function populate(dir: string, names: readonly string[]): Promise<void> {
  await mkdir(join(dir, 'assets'), { recursive: true });
  for (const n of names) await writeFile(join(dir, 'assets', n), `/* ${n} */`);
}

async function usageError(p: () => unknown): Promise<OtelHtmlError> {
  try {
    await p();
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('packageDirViewerAssets', () => {
  test('selects the hashed entry script and style and serves every asset', async () => {
    await populate(root, ['viewer.abc123.js', 'viewer.abc123.css', 'font.woff2']);
    const assets = packageDirViewerAssets(urlOf(root));
    expect(assets.entry()).toEqual({ script: 'assets/viewer.abc123.js', style: 'assets/viewer.abc123.css' });
    const files = await assets.files();
    expect(files.map((f) => f.path)).toEqual([
      'assets/font.woff2',
      'assets/viewer.abc123.css',
      'assets/viewer.abc123.js',
    ]);
    expect(new TextDecoder().decode(files[2]?.contents)).toBe('/* viewer.abc123.js */');
  });

  test('a build without css has no style', async () => {
    await populate(root, ['viewer.abc123.js']);
    expect(packageDirViewerAssets(urlOf(root)).entry()).toEqual({
      script: 'assets/viewer.abc123.js',
      style: null,
    });
  });

  test('a missing directory is a usage error naming it', async () => {
    const missing = join(root, 'nope');
    const e = await usageError(() => packageDirViewerAssets(urlOf(missing)).entry());
    expect(e.code).toBe('usage');
    expect(e.message).toContain(missing);
    expect(e.hint).toContain('viewer build');
  });

  test('a missing entry script is a usage error', async () => {
    await populate(root, ['viewer.abc123.css', 'other.js']);
    const e = await usageError(() => packageDirViewerAssets(urlOf(root)).files());
    expect(e.code).toBe('usage');
    expect(e.message).toContain('viewer.<hash>.js');
  });

  test('more than one hashed entry is a usage error (a stale mixed build)', async () => {
    await populate(root, ['viewer.aaa.js', 'viewer.bbb.js', 'viewer.aaa.css']);
    const e = await usageError(() => packageDirViewerAssets(urlOf(root)).entry());
    expect(e.code).toBe('usage');
    expect(e.message).toContain('viewer.aaa.js');
    expect(e.message).toContain('viewer.bbb.js');
  });

  test('more than one stylesheet is a usage error', async () => {
    await populate(root, ['viewer.aaa.js', 'viewer.aaa.css', 'viewer.bbb.css']);
    const e = await usageError(() => packageDirViewerAssets(urlOf(root)).entry());
    expect(e.message).toContain('viewer.<hash>.css');
  });

  test('the first candidate directory that exists wins (src/ vs dist/ layouts)', async () => {
    const first = join(root, 'first');
    const second = join(root, 'second');
    await populate(second, ['viewer.two.js']);
    expect(packageDirViewerAssets([urlOf(first), urlOf(second)]).entry().script).toBe('assets/viewer.two.js');
    await populate(first, ['viewer.one.js']);
    expect(packageDirViewerAssets([urlOf(first), urlOf(second)]).entry().script).toBe('assets/viewer.one.js');
  });

  test('no candidate exists: the error lists every place tried', async () => {
    const a = join(root, 'a');
    const b = join(root, 'b');
    const e = await usageError(() => packageDirViewerAssets([urlOf(a), urlOf(b)]).entry());
    expect(e.message).toContain(a);
    expect(e.message).toContain(b);
  });
});
