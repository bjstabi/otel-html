import { readdirSync, readFileSync } from 'node:fs';
import { OtelHtmlError } from '../model/errors.js';
import type { ViewerAsset, ViewerAssets } from '../writer/viewer-assets.js';

/**
 * Viewer files shipped next to the library: `<dir>/assets/**`, with the entry script and optional style
 * named `viewer.<hash>.js` / `viewer.<hash>.css`. Read lazily on first use. (The viewer build that fills
 * this directory arrives with the viewer shell.)
 */
export function packageDirViewerAssets(dir: URL): ViewerAssets {
  let cache: { files: ViewerAsset[]; script: string; style: string | null } | null = null;

  const load = (): NonNullable<typeof cache> => {
    if (cache !== null) return cache;
    const assetsDir = new URL('assets/', dir);
    let names: string[];
    try {
      names = readdirSync(assetsDir).sort();
    } catch (e) {
      throw new OtelHtmlError('usage', {
        message: `viewer assets not found at ${assetsDir.pathname}: ${e instanceof Error ? e.message : String(e)}`,
        hint: 'run the viewer build, or pass your own viewerAssets',
      });
    }
    const files = names.map((n) => ({
      path: `assets/${n}`,
      contents: new Uint8Array(readFileSync(new URL(n, assetsDir))),
    }));
    const script = names.find((n) => /^viewer\.[A-Za-z0-9_-]+\.js$/.test(n));
    if (script === undefined) {
      throw new OtelHtmlError('usage', {
        message: `viewer assets at ${assetsDir.pathname} contain no viewer.<hash>.js entry script`,
        hint: 'run the viewer build',
      });
    }
    const style = names.find((n) => /^viewer\.[A-Za-z0-9_-]+\.css$/.test(n));
    cache = { files, script: `assets/${script}`, style: style === undefined ? null : `assets/${style}` };
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
