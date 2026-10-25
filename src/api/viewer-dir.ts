import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OtelHtmlError } from '../model/errors.js';
import type { ViewerAsset, ViewerAssets } from '../writer/viewer-assets.js';

interface Loaded {
  files: ViewerAsset[];
  script: string;
  style: string | null;
}

function usage(message: string): OtelHtmlError {
  return new OtelHtmlError('usage', { message, hint: 'run the viewer build, or pass your own viewerAssets' });
}

/** Exactly one `viewer.<hash>.<ext>` is expected; several mean a stale or mixed build. */
function pick(names: readonly string[], ext: 'js' | 'css', dir: string, required: boolean): string | null {
  const matches = names.filter((n) => new RegExp(`^viewer\\.[A-Za-z0-9_-]+\\.${ext}$`).test(n));
  const [only, ...rest] = matches;
  if (only === undefined) {
    if (required) throw usage(`viewer assets at ${dir} contain no viewer.<hash>.${ext} entry`);
    return null;
  }
  if (rest.length > 0) {
    throw usage(`viewer assets at ${dir} contain more than one viewer.<hash>.${ext}: ${matches.join(', ')}`);
  }
  return `assets/${only}`;
}

/**
 * Viewer files shipped with the package: `<dir>/assets/**`, with the entry script (required) and style
 * (optional) named `viewer.<hash>.js` / `viewer.<hash>.css`. `dirs` are candidate locations; the first
 * whose `assets/` exists is used, so one call works from `src/api/` (development, tests) and from the
 * published `dist/` layout. Read lazily on first use; errors are `usage` errors.
 */
export function packageDirViewerAssets(dirs: URL | readonly URL[]): ViewerAssets {
  const candidates = dirs instanceof URL ? [dirs] : dirs;
  let cache: Loaded | null = null;

  const load = (): Loaded => {
    if (cache !== null) return cache;
    const assetsDirs = candidates.map((d) => new URL('assets/', d));
    const assetsDir = assetsDirs.find((d) => existsSync(d));
    if (assetsDir === undefined) {
      throw usage(
        `viewer assets not found; looked in ${assetsDirs.map((d) => fileURLToPath(d)).join(', ') || '(nowhere)'}`,
      );
    }
    const where = fileURLToPath(assetsDir);
    const names = readdirSync(assetsDir).sort();
    const script = pick(names, 'js', where, true);
    if (script === null) throw usage(`viewer assets at ${where} contain no viewer.<hash>.js entry`);
    const style = pick(names, 'css', where, false);
    const files = names.map((n) => ({
      path: `assets/${n}`,
      contents: new Uint8Array(readFileSync(new URL(n, assetsDir))),
    }));
    cache = { files, script, style };
    return cache;
  };

  return {
    async files() {
      return load().files;
    },
    entry() {
      const { script, style } = load();
      return { script, style };
    },
  };
}
