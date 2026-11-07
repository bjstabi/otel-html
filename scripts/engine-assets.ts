// Copies the DuckDB-WASM engine files from @duckdb/duckdb-wasm into the viewer's assets.
//   bun scripts/engine-assets.ts [--out dist/viewer/assets]
// A `site` report serves duckdb.<v>.wasm and duckdb.<v>.worker.js as they are. A `local` report opens from file://,
// where fetch is blocked, so it loads the same bytes as classic scripts that push base64 onto `__OH__`: the
// WASM gzipped at level 9, the worker as it is.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ENGINE_VERSION, engineAssetNames } from '../src/writer/engine-assets.js';

const WASM = 'duckdb-eh.wasm';
const WORKER = 'duckdb-browser-eh.worker.js';

function packageDist(): string {
  const require = createRequire(import.meta.url);
  // The package's `exports` hides package.json, so go up from the entry file in dist/.
  const dir = dirname(dirname(require.resolve('@duckdb/duckdb-wasm')));
  const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string })
    .version;
  if (version !== ENGINE_VERSION) {
    throw new Error(`@duckdb/duckdb-wasm ${version} is installed but ENGINE_VERSION is ${ENGINE_VERSION}`);
  }
  return join(dir, 'dist');
}

const push = (key: string, bytes: Uint8Array): string =>
  `__OH__.push(${JSON.stringify(key)},${JSON.stringify(Buffer.from(bytes).toString('base64'))});\n`;

/** Writes the four engine files into `outDir`; returns their names. `distDir` defaults to the installed package's. */
export function buildEngineAssets(opts: { distDir?: string; outDir: string }): string[] {
  const distDir = opts.distDir ?? packageDist();
  const [plainWasm = '', plainWorker = ''] = engineAssetNames('site');
  const [wrapWasm = '', wrapWorker = ''] = engineAssetNames('local');
  mkdirSync(opts.outDir, { recursive: true });
  copyFileSync(join(distDir, WASM), join(opts.outDir, plainWasm));
  copyFileSync(join(distDir, WORKER), join(opts.outDir, plainWorker));
  const wasm = readFileSync(join(distDir, WASM));
  writeFileSync(join(opts.outDir, wrapWasm), push('engine/wasm.gz', gzipSync(wasm, { level: 9 })));
  writeFileSync(join(opts.outDir, wrapWorker), push('engine/worker', readFileSync(join(distDir, WORKER))));
  return [plainWasm, plainWorker, wrapWasm, wrapWorker];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--out');
  const out = resolve(i === -1 ? 'dist/viewer/assets' : (process.argv[i + 1] ?? 'dist/viewer/assets'));
  for (const n of buildEngineAssets({ outDir: out })) process.stdout.write(`engine asset ${n}\n`);
}
