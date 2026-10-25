import { OtelHtmlError } from '../model/errors.js';

export interface ViewerEntry {
  script: string;
  style: string | null;
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const ASSET_PATH = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assetUrl(p: string, what: string): string {
  if (!ASSET_PATH.test(p) || p.includes('..')) {
    throw new OtelHtmlError('invalid-report', {
      path: `viewer entry ${what}`,
      expected: 'a relative path like assets/viewer.<hash>.js',
      actual: JSON.stringify(p),
    });
  }
  return escapeHtml(p);
}

/**
 * The report shell: a one-line `__OH__` queue so data files can register before the viewer loads, then
 * classic scripts only (no modules, so it works from file://). Title and paths are escaped.
 */
export function renderIndexHtml(entry: ViewerEntry, title: string): string {
  const style =
    entry.style === null ? '' : `<link rel="stylesheet" href="${assetUrl(entry.style, 'style')}">\n`;
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
<script src="${assetUrl(entry.script, 'script')}"></script>
</body>
</html>
`;
}
