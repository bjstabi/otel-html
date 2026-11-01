import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { serve } from '../e2e/static-server.js';

/**
 * Serves the `mise run demo` report through code-server's port proxy and opens it in the browser. There the browser
 * runs on another machine, so a `file://` path to the report on this one cannot load. Runs until interrupted.
 *
 *   bun scripts/demo-serve.ts <report-dir>
 */
const [dir] = process.argv.slice(2);
const { VSCODE_PROXY_URI: proxy, BROWSER: browser } = process.env;
if (dir === undefined || proxy === undefined)
  throw new Error('usage: VSCODE_PROXY_URI=… demo-serve.ts <report-dir>');

const { port } = await serve([{ prefix: '', root: resolve(dir) }]);
const url = new URL(`${proxy.replace('{{port}}', String(port))}index.html`);
// A trailing dot names the same host but is another origin, outside an installed code-server app's scope: the
// report then opens in a browser tab, with navigation buttons, rather than in another chromeless app window.
if (/\.[a-z]+$/i.test(url.hostname)) url.hostname = `${url.hostname}.`;
process.stdout.write(`otel-html demo: ${url.href}\nCtrl-C to stop.\n`);

if (browser !== undefined) spawn(browser, [url.href], { stdio: 'ignore', detached: true }).unref();
