import { describe, expect, test } from 'vitest';
import type { ConfigInput } from '../../src/config/schema.js';
import { engineAssetNames } from '../../src/writer/engine-assets.js';
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
