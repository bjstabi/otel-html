import type { ReportFormat } from '../config/schema.js';
import { engineAssetNames } from '../format/engine.js';
import { assetFileName, ENGINE_ASSET_RE } from '../format/paths.js';
import { OtelHtmlError } from '../model/errors.js';
import type { ViewerEntry } from './html.js';
import type { FileSystem } from './ports.js';

export interface ViewerAsset {
  path: string;
  contents: Uint8Array;
}

export interface ViewerAssets {
  /**
   * The files to copy beside a report of this format: the viewer's own, plus the DuckDB engine files that format
   * loads (`local` the base64 wrappers, `site` the plain files). No format means no engine files.
   */
  files(format?: ReportFormat): Promise<readonly ViewerAsset[]>;
  entry(): ViewerEntry;
}

/** The file name the binary build embeds parquet-wasm's WASM under (see `scripts/build-binaries.ts`); not a viewer asset. */
const PARQUET_WASM_FILE = 'parquet_wasm_bg.wasm';

/** False for an engine file a report of this format does not load; true for every other path. */
export function wantsAsset(path: string, format?: ReportFormat): boolean {
  if (!ENGINE_ASSET_RE.test(path)) return true;
  if (format === undefined) return false;
  return engineAssetNames(format).includes(assetFileName(path));
}

/** Drops the engine files a report of this format does not load; every other file stays. */
export function withEngineFiles(files: readonly ViewerAsset[], format?: ReportFormat): ViewerAsset[] {
  return files.filter((f) => wantsAsset(f.path, format));
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

export async function writeViewerAssets(
  fs: FileSystem,
  out: string,
  assets: ViewerAssets,
  format?: ReportFormat,
): Promise<void> {
  for (const f of await assets.files(format)) {
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

const ENTRY_RE = {
  js: /^viewer\.[A-Za-z0-9_-]+\.js$/,
  css: /^viewer\.[A-Za-z0-9_-]+\.css$/,
} as const;

/** The names that are `viewer.<hash>.<ext>` entries, in input order. */
export function viewerEntryNames(names: readonly string[], ext: 'js' | 'css'): string[] {
  const re = ENTRY_RE[ext];
  return names.filter((n) => re.test(n));
}

function embeddedEntry(names: readonly string[], ext: 'js' | 'css', required: boolean): string | null {
  const matches = viewerEntryNames(names, ext);
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
  // The parquet codec's WASM is embedded beside the viewer files but is not one of them.
  const embedded = (bun?.embeddedFiles ?? []).filter((f) => f.name !== PARQUET_WASM_FILE);
  const names = embedded.map((f) => f.name);
  return {
    async files(format) {
      // Filtered before reading, so the 44 MB of engine files stay unread for a report that does not take them.
      // One at a time, so a read finishes before the next starts.
      const out: ViewerAsset[] = [];
      for (const f of embedded) {
        if (!wantsAsset(`assets/${f.name}`, format)) continue;
        out.push({ path: `assets/${f.name}`, contents: new Uint8Array(await f.arrayBuffer()) });
      }
      return out;
    },
    entry() {
      const script = embeddedEntry(names, 'js', true);
      if (script === null) throw new OtelHtmlError('usage', { message: 'no embedded viewer script' });
      return { script, style: embeddedEntry(names, 'css', false) };
    },
  };
}
