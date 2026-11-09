// Copies the DuckDB-WASM engine files from @duckdb/duckdb-wasm into the viewer's assets, with the two DuckDB
// extensions (parquet, json) the viewer's SQL needs.
//   bun scripts/engine-assets.ts [--out dist/viewer/assets]
// A `site` report serves duckdb.<v>.wasm and duckdb.<v>.worker.js as they are. A `local` report opens from file://,
// where fetch is blocked, so it loads the same bytes as classic scripts that push base64 onto `__OH__`: the
// WASM gzipped at level 9, the worker as it is.
// The host's DuckDB-WASM Node build (duckdb.<v>.node.cjs, duckdb.<v>.node.worker.cjs) is bundled with tsdown so that
// apache-arrow, which both files require, is inlined: they resolve no package at run time (D44), in npm and in the
// binary alike. Node builtins and the worker's optional, try-required ws addons stay external. No report carries them.
// The extensions are the officially signed binaries for the engine's DuckDB core version, downloaded from
// extensions.duckdb.org at build time into the git-ignored `.cache/duckdb-extensions/`, checked against the SHA-256
// pinned in scripts/duckdb-extensions.json, and reused from the cache while they verify. Set
// OTEL_HTML_DUCKDB_EXTENSIONS_DIR to a directory holding `<name>.duckdb_extension.wasm` for an offline build.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'tsdown';
import {
  ENGINE_EXTENSIONS,
  ENGINE_VERSION,
  ENGINE_WASM_KEY,
  ENGINE_WORKER_KEY,
  type EngineExtension,
  engineAssetNames,
  engineExtensionKey,
  engineExtensionName,
  engineNodeAssetNames,
} from '../src/format/engine.js';

const WASM = 'duckdb-eh.wasm';
const WORKER = 'duckdb-browser-eh.worker.js';
const NODE_BINDINGS = 'duckdb-node.cjs';
const NODE_WORKER = 'duckdb-node-eh.worker.cjs';

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

/** Bundles one Node engine file with apache-arrow inlined; the other requires (builtins, ws's addons) stay as they are. */
async function bundleNodeFile(input: string, output: string): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'engine-bundle-'));
  try {
    await build({
      config: false,
      entry: { out: input },
      outDir: tmp,
      format: 'cjs',
      platform: 'node',
      target: false,
      dts: false,
      clean: false,
      minify: true,
      sourcemap: false,
      logLevel: 'silent',
      outExtensions: () => ({ js: '.cjs' }),
      deps: { alwaysBundle: ['apache-arrow'], neverBundle: ['bufferutil', 'utf-8-validate'] },
    });
    copyFileSync(join(tmp, 'out.cjs'), output);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const push = (key: string, bytes: Uint8Array): string =>
  `__OH__.push(${JSON.stringify(key)},${JSON.stringify(Buffer.from(bytes).toString('base64'))});\n`;

/** The pinned extension build: the DuckDB core version, the platform, and the SHA-256 of each extension file. */
export interface ExtensionPins {
  core: string;
  platform: string;
  sha256: Record<EngineExtension, string>;
}

const PINS_FILE = new URL('./duckdb-extensions.json', import.meta.url);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Where the extensions come from: the pinned build, a cache, an optional local directory, and the download. */
export interface ExtensionSource {
  pins?: ExtensionPins;
  /** The git-ignored cache; a verified file there means no network. Default `.cache/duckdb-extensions`. */
  cacheDir?: string;
  /** A directory of `<name>.duckdb_extension.wasm` files for an offline build; nothing is downloaded when set. */
  localDir?: string;
  download?: (url: string) => Promise<Uint8Array>;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

function verified(file: string, bytes: Uint8Array, want: string): Uint8Array {
  const got = sha256(bytes);
  if (got !== want) {
    throw new Error(`${file}: SHA-256 is ${got}, but scripts/duckdb-extensions.json pins ${want}`);
  }
  return bytes;
}

/** The two extension files as bytes, each verified against its pin; from the local dir, the cache, or the network. */
export async function obtainExtensions(
  source: ExtensionSource = {},
): Promise<Record<EngineExtension, Uint8Array>> {
  const pins = source.pins ?? (JSON.parse(readFileSync(PINS_FILE, 'utf8')) as ExtensionPins);
  const cacheDir = source.cacheDir ?? resolve('.cache/duckdb-extensions');
  const download = source.download ?? fetchBytes;
  const out = {} as Record<EngineExtension, Uint8Array>;
  for (const ext of ENGINE_EXTENSIONS) {
    const file = `${ext}.duckdb_extension.wasm`;
    const want = pins.sha256[ext];
    if (source.localDir !== undefined) {
      out[ext] = verified(join(source.localDir, file), readFileSync(join(source.localDir, file)), want);
      continue;
    }
    const cached = join(cacheDir, file);
    if (existsSync(cached)) {
      const bytes = readFileSync(cached);
      if (sha256(bytes) === want) {
        out[ext] = bytes;
        continue;
      }
    }
    const url = `https://extensions.duckdb.org/${pins.core}/${pins.platform}/${file}`;
    const bytes = verified(url, await download(url), want);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, bytes);
    out[ext] = bytes;
  }
  return out;
}

/** Writes the engine files (WASM, worker, extensions; plain and wrapped; the host's two Node files) into `outDir`; returns their names. `distDir` defaults to the installed package's. */
export async function buildEngineAssets(opts: {
  distDir?: string;
  outDir: string;
  extensions?: ExtensionSource;
}): Promise<string[]> {
  const distDir = opts.distDir ?? packageDist();
  const [plainWasm = '', plainWorker = ''] = engineAssetNames('site');
  const [wrapWasm = '', wrapWorker = ''] = engineAssetNames('local');
  const extensions = await obtainExtensions(opts.extensions);
  mkdirSync(opts.outDir, { recursive: true });
  copyFileSync(join(distDir, WASM), join(opts.outDir, plainWasm));
  copyFileSync(join(distDir, WORKER), join(opts.outDir, plainWorker));
  const wasm = readFileSync(join(distDir, WASM));
  writeFileSync(join(opts.outDir, wrapWasm), push(ENGINE_WASM_KEY, gzipSync(wasm, { level: 9 })));
  writeFileSync(join(opts.outDir, wrapWorker), push(ENGINE_WORKER_KEY, readFileSync(join(distDir, WORKER))));
  const node = engineNodeAssetNames();
  await bundleNodeFile(join(distDir, NODE_BINDINGS), join(opts.outDir, node.bindings));
  await bundleNodeFile(join(distDir, NODE_WORKER), join(opts.outDir, node.worker));
  const names = [plainWasm, plainWorker, wrapWasm, wrapWorker, node.bindings, node.worker];
  for (const ext of ENGINE_EXTENSIONS) {
    const site = engineExtensionName('site', ext);
    const local = engineExtensionName('local', ext);
    writeFileSync(join(opts.outDir, site), extensions[ext]);
    writeFileSync(
      join(opts.outDir, local),
      push(engineExtensionKey(ext), gzipSync(extensions[ext], { level: 9 })),
    );
    names.push(site, local);
  }
  return names;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--out');
  const out = resolve(i === -1 ? 'dist/viewer/assets' : (process.argv[i + 1] ?? 'dist/viewer/assets'));
  const { OTEL_HTML_DUCKDB_EXTENSIONS_DIR: localDir } = process.env;
  const names = await buildEngineAssets({
    outDir: out,
    extensions: localDir === undefined || localDir === '' ? {} : { localDir: resolve(localDir) },
  });
  for (const n of names) process.stdout.write(`engine asset ${n}\n`);
}
