import { ENGINE_VERSION, engineAssetNames } from '../format/engine.js';
import { ASSETS_BASE_RE, assetFileName, DEFAULT_ASSETS_BASE } from '../format/paths.js';
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

/** The body of the inline script that starts the engine downloads (`__OH__.pre[href]`) through cache `cacheName`. */
export function enginePrefetchScript(hrefs: readonly string[], cacheName: string): string {
  return `(()=>{const n=${JSON.stringify(cacheName)},p=__OH__.pre={};let s=[];
const c=typeof caches==="undefined"?Promise.resolve(null):caches.open(n).catch(()=>null);
const get=u=>c.then(k=>(k?k.match(u,{ignoreVary:true}).catch(()=>undefined):Promise.resolve(undefined)).then(r=>r?r.arrayBuffer():fetch(u).then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);if(k)s.push([u,r.clone()]);return r.arrayBuffer()})));
for(const u of ${JSON.stringify(hrefs)}){p[u]=get(u);p[u].catch(()=>{})}
__OH__.store=()=>{const t=s;s=[];return c.then(k=>k&&Promise.allSettled(t.map(e=>k.put(e[0],e[1]))).then(()=>caches.keys()).then(ks=>Promise.allSettled(ks.filter(x=>x.startsWith("oh-engine-")&&x!==n).map(x=>caches.delete(x))))).then(()=>{},()=>{})};
__OH__.drop=()=>c.then(k=>k&&caches.delete(n)).then(()=>{},()=>{});})()`;
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
  return escapeHtml(base + assetFileName(p));
}

/**
 * The report shell: a one-line `__OH__` queue so data files can register before the viewer loads, then
 * classic scripts only (no modules, so it works from file://). Title and paths are escaped. The viewer files
 * resolve under `assetsBase` (the report's own `assets/` by default); `data/manifest.js` is always the report's. With `host` (the query endpoint, relative to the page) a
 * meta tag tells the viewer it is served by `otel-html host`. With `format: 'site'` an inline script after the
 * bootstrap starts the engine downloads at once, as promises on `__OH__.pre` keyed by the page-relative href
 * (`assetsBase` + file name), so the viewer awaits them instead of starting them after it has parsed.
 */
export function renderIndexHtml(
  entry: ViewerEntry,
  title: string,
  opts: { assetsBase?: string; host?: string; format?: 'local' | 'site' } = {},
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
  const host =
    opts.host === undefined ? '' : `<meta name="otel-html-host" content="${escapeHtml(opts.host)}">\n`;
  // A site's engine files (the wasm, its worker) are the report's biggest download, so the shell starts them before
  // the viewer script is parsed. Each one is looked up in a Cache API cache named for the engine version first; a
  // miss is fetched and kept aside, and the viewer calls `store()` once the engine runs (writing the cache, dropping
  // other versions') or `drop()` when the cached bytes proved bad. A browser without `caches` just fetches.
  // ASSETS_BASE_RE admits only [A-Za-z0-9._/-], and the engine file names are plain: no `<`, `&` or quote can
  // occur, so the JSON strings are safe inside the inline script and each key stays exactly `base + name`.
  const pre =
    opts.format === 'site'
      ? `<script>${enginePrefetchScript(
          engineAssetNames('site').map((n) => base + n),
          `oh-engine-${ENGINE_VERSION}`,
        )}</script>\n`
      : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${host}<title>${escapeHtml(title)}</title>
${style}</head>
<body>
<div id="root"></div>
<script>window.__OH__={q:[],push(k,p){this.q.push([k,p])}}</script>
${pre}<script src="data/manifest.js"></script>
<script src="${assetUrl(entry.script, 'script', base)}"></script>
</body>
</html>
`;
}
