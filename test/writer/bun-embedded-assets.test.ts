import { expect, test } from 'vitest';
import {
  type BunLike,
  bunEmbeddedViewerAssets,
  hasBunEmbeddedFiles,
  viewerEntryNames,
} from '../../src/writer/viewer-assets.js';

function bunWith(...names: string[]): BunLike {
  return { embeddedFiles: names.map((n) => Object.assign(new Blob([n]), { name: n })) };
}

test('no Bun global or no embedded files means not embedded', () => {
  expect(hasBunEmbeddedFiles(undefined)).toBe(false);
  expect(hasBunEmbeddedFiles({ embeddedFiles: [] })).toBe(false);
  expect(hasBunEmbeddedFiles(bunWith('viewer.abc.js'))).toBe(true);
});

test('embedded files become assets/ paths with a script and optional style entry', async () => {
  const assets = bunEmbeddedViewerAssets(bunWith('viewer.abc.js', 'viewer.def.css'));
  expect(assets.entry()).toEqual({ script: 'assets/viewer.abc.js', style: 'assets/viewer.def.css' });
  const files = await assets.files();
  expect(files.map((f) => f.path)).toEqual(['assets/viewer.abc.js', 'assets/viewer.def.css']);
  expect(new TextDecoder().decode(files[0]?.contents)).toBe('viewer.abc.js');
});

test('a css-less build is accepted and a missing or ambiguous script is a usage error', () => {
  expect(bunEmbeddedViewerAssets(bunWith('viewer.abc.js')).entry()).toEqual({
    script: 'assets/viewer.abc.js',
    style: null,
  });
  expect(() => bunEmbeddedViewerAssets(bunWith('viewer.abc.css')).entry()).toThrowError(/exactly one/);
  expect(() => bunEmbeddedViewerAssets(bunWith('viewer.a.js', 'viewer.b.js')).entry()).toThrowError(
    /exactly one/,
  );
});

test('viewerEntryNames keeps only viewer.<hash>.<ext>', () => {
  const names = [
    'viewer.Ab_1-z.js',
    'viewer.Ab.css',
    'viewer.js',
    'xviewer.a.js',
    'viewer.a.js.map',
    'receiver-1.js',
    'viewer.b.js',
  ];
  expect(viewerEntryNames(names, 'js')).toEqual(['viewer.Ab_1-z.js', 'viewer.b.js']);
  expect(viewerEntryNames(names, 'css')).toEqual(['viewer.Ab.css']);
  expect(viewerEntryNames([], 'js')).toEqual([]);
});
