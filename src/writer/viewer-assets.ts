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

/** The slice of Bun's global this module touches; typed locally so no `@types/bun` is needed. */
export interface BunLike {
  readonly embeddedFiles?: readonly (Blob & { readonly name: string })[];
}

function bunGlobal(): BunLike | undefined {
  return (globalThis as { Bun?: BunLike }).Bun;
}

/** True inside a `bun build --compile` binary that embedded files (always false under plain Node). */
export function hasBunEmbeddedFiles(bun: BunLike | undefined = bunGlobal()): boolean {
  return (bun?.embeddedFiles?.length ?? 0) > 0;
}

function embeddedEntry(names: readonly string[], ext: 'js' | 'css', required: boolean): string | null {
  const matches = names.filter((n) => new RegExp(`^viewer\\.[A-Za-z0-9_-]+\\.${ext}$`).test(n));
  if (matches.length === 1) return `assets/${matches[0]}`;
  if (matches.length === 0 && !required) return null;
  throw new OtelHtmlError('usage', {
    message: `embedded viewer assets contain ${matches.length} viewer.<hash>.${ext} entries, expected exactly one`,
    hint: 'rebuild the binary with `mise run build && mise run build:binaries`',
  });
}

/**
 * Viewer files embedded in a Bun-compiled binary (`Bun.embeddedFiles`, named `<file>` from the
 * `assets/` folder because the binary is built with `--asset-naming '[name].[ext]'`).
 */
export function bunEmbeddedViewerAssets(bun: BunLike | undefined = bunGlobal()): ViewerAssets {
  const embedded = bun?.embeddedFiles ?? [];
  const names = embedded.map((f) => f.name);
  return {
    async files() {
      return Promise.all(
        embedded.map(async (f) => ({
          path: `assets/${f.name}`,
          contents: new Uint8Array(await f.arrayBuffer()),
        })),
      );
    },
    entry() {
      const script = embeddedEntry(names, 'js', true);
      if (script === null) throw new OtelHtmlError('usage', { message: 'no embedded viewer script' });
      return { script, style: embeddedEntry(names, 'css', false) };
    },
  };
}
