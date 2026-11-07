import { ASSETS_BASE_RE, DEFAULT_ASSETS_BASE } from '../format/paths.js';
import { OtelHtmlError } from '../model/errors.js';

export interface ViewerEntry {
  script: string;
  style: string | null;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const ASSET_PATH = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assetUrl(p: string, what: string, base: string): string {
  if (!ASSET_PATH.test(p) || p.includes('..')) {
    throw new OtelHtmlError('invalid-report', {
      path: `viewer entry ${what}`,
      expected: 'a relative path like assets/viewer.<hash>.js',
      actual: JSON.stringify(p),
    });
  }
  return escapeHtml(base + p.slice(DEFAULT_ASSETS_BASE.length));
}

/**
 * The report shell: a one-line `__OH__` queue so data files can register before the viewer loads, then
 * classic scripts only (no modules, so it works from file://). Title and paths are escaped. The viewer files
 * resolve under `assetsBase` (the report's own `assets/` by default); `data/manifest.js` is always the report's.
 */
export function renderIndexHtml(
  entry: ViewerEntry,
  title: string,
  opts: { assetsBase?: string } = {},
): string {
  const base = opts.assetsBase ?? DEFAULT_ASSETS_BASE;
  if (!ASSETS_BASE_RE.test(base)) {
    throw new OtelHtmlError('invalid-report', {
      path: 'assetsBase',
      expected: 'assets/ or a relative path like ../../assets/0.3.0/',
      actual: JSON.stringify(base),
    });
  }
  const style =
    entry.style === null ? '' : `<link rel="stylesheet" href="${assetUrl(entry.style, 'style', base)}">\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${style}</head>
<body>
<div id="root"></div>
<script>window.__OH__={q:[],push(k,p){this.q.push([k,p])}}</script>
<script src="data/manifest.js"></script>
<script src="${assetUrl(entry.script, 'script', base)}"></script>
</body>
</html>
`;
}
