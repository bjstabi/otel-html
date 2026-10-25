import { OtelHtmlError } from '../model/errors.js';
import type { ViewerEntry } from './html.js';
import type { FileSystem } from './ports.js';

export interface ViewerAsset {
  path: string;
  contents: Uint8Array;
}

export interface ViewerAssets {
  files(): Promise<readonly ViewerAsset[]>;
  entry(): ViewerEntry;
}

const SAFE_SEGMENT = /^[A-Za-z0-9.][A-Za-z0-9._-]*$/;

/** Viewer files must land under `assets/`, with no `..`, no leading `_` and no absolute or scheme paths. */
export function assertAssetPath(path: string): void {
  const segments = path.split('/');
  const ok =
    segments.length >= 2 &&
    segments[0] === 'assets' &&
    segments.every((s) => SAFE_SEGMENT.test(s) && s !== '.' && s !== '..' && !s.startsWith('..'));
  if (!ok) {
    throw new OtelHtmlError('invalid-report', {
      path: 'viewer asset',
      expected: 'a relative path under assets/ with no `..` and no segment starting with `_`',
      actual: JSON.stringify(path),
    });
  }
}

export async function writeViewerAssets(fs: FileSystem, out: string, assets: ViewerAssets): Promise<void> {
  for (const f of await assets.files()) {
    assertAssetPath(f.path);
    await fs.writeBytes(`${out}/${f.path}`, f.contents);
  }
}
