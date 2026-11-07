import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, test, vi } from 'vitest';
import { buildEngineAssets, type ExtensionPins, obtainExtensions } from '../../scripts/engine-assets.js';
import { ENGINE_VERSION, engineAssetNames, engineExtensionName } from '../../src/format/engine.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const PQ = new Uint8Array(300).fill(1);
const JS = new Uint8Array(200).fill(2);
const PINS: ExtensionPins = {
  core: 'v9.9.9',
  platform: 'wasm_eh',
  sha256: { parquet: sha(PQ), json: sha(JS) },
};
const fakeDownload = () =>
  vi.fn(async (url: string) => (url.endsWith('/parquet.duckdb_extension.wasm') ? PQ : JS));

/** Extension inputs that never touch the network or the repo's cache. */
function exts(root: string, download = fakeDownload()) {
  return { pins: PINS, cacheDir: join(root, 'cache'), download };
}

function fakeDist(): { dist: string; out: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'engine-assets-'));
  dirs.push(root);
  const dist = join(root, 'dist');
  const out = join(root, 'assets');
  mkdirSync(dist);
  mkdirSync(out);
  writeFileSync(join(dist, 'duckdb-eh.wasm'), new Uint8Array(5000).fill(7));
  writeFileSync(join(dist, 'duckdb-browser-eh.worker.js'), 'console.log("worker");');
  return { dist, out, root };
}

test('writes the engine files named by the package version', async () => {
  const { dist, out, root } = fakeDist();
  const names = await buildEngineAssets({ distDir: dist, outDir: out, extensions: exts(root) });
  expect([...names].sort()).toEqual([...engineAssetNames('site'), ...engineAssetNames('local')].sort());
  expect(readFileSync(join(out, engineExtensionName('site', 'parquet')))).toEqual(Buffer.from(PQ));
  expect(readFileSync(join(out, `duckdb.${ENGINE_VERSION}.wasm`))).toEqual(
    readFileSync(join(dist, 'duckdb-eh.wasm')),
  );
  expect(readFileSync(join(out, `duckdb.${ENGINE_VERSION}.worker.js`), 'utf8')).toBe(
    'console.log("worker");',
  );
});

test('the b64 wrappers push gzip (wasm, extensions) and plain (worker) base64 under the engine keys', async () => {
  const { dist, out, root } = fakeDist();
  await buildEngineAssets({ distDir: dist, outDir: out, extensions: exts(root) });
  const ext = readFileSync(join(out, engineExtensionName('local', 'json')), 'utf8');
  const e = /^__OH__\.push\("engine\/ext\/json\.gz","([A-Za-z0-9+/=]+)"\);?\n?$/.exec(ext);
  expect(gunzipSync(Buffer.from(e?.[1] ?? '', 'base64'))).toEqual(Buffer.from(JS));
  const wasm = readFileSync(join(out, `duckdb.${ENGINE_VERSION}.wasm.gz.b64.js`), 'utf8');
  const m = /^__OH__\.push\("engine\/wasm\.gz","([A-Za-z0-9+/=]+)"\);?\n?$/.exec(wasm);
  expect(m).not.toBeNull();
  expect(gunzipSync(Buffer.from(m?.[1] ?? '', 'base64'))).toEqual(readFileSync(join(dist, 'duckdb-eh.wasm')));
  const worker = readFileSync(join(out, `duckdb.${ENGINE_VERSION}.worker.b64.js`), 'utf8');
  const w = /^__OH__\.push\("engine\/worker","([A-Za-z0-9+/=]+)"\);?\n?$/.exec(worker);
  expect(Buffer.from(w?.[1] ?? '', 'base64').toString('utf8')).toBe('console.log("worker");');
});

test('the gzip is deterministic: mtime 0 and identical bytes on every run', async () => {
  const { dist, out, root } = fakeDist();
  const out2 = join(dirname(out), 'assets2');
  await buildEngineAssets({ distDir: dist, outDir: out, extensions: exts(root) });
  await buildEngineAssets({ distDir: dist, outDir: out2, extensions: exts(root) });
  const file = `duckdb.${ENGINE_VERSION}.wasm.gz.b64.js`;
  const a = readFileSync(join(out, file), 'utf8');
  expect(a).toBe(readFileSync(join(out2, file), 'utf8'));
  const gz = Buffer.from(/"engine\/wasm\.gz","([^"]+)"/.exec(a)?.[1] ?? '', 'base64');
  expect(gz.readUInt32LE(4)).toBe(0);
});

test('the real package files stay near the spike sizes (9.8 MB gzip+base64, 34 MB plain)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-assets-real-'));
  dirs.push(root);
  await buildEngineAssets({ outDir: root });
  const size = (n: string) => readFileSync(join(root, n)).length;
  const near = (actual: number, expected: number) => Math.abs(actual - expected) / expected < 0.1;
  expect(near(size(`duckdb.${ENGINE_VERSION}.wasm.gz.b64.js`), 9.8e6)).toBe(true);
  expect(near(size(`duckdb.${ENGINE_VERSION}.wasm`), 34e6)).toBe(true);
});

test('a verified cache file is reused with no download', async () => {
  const { root } = fakeDist();
  const download = fakeDownload();
  await obtainExtensions(exts(root, download));
  expect(download).toHaveBeenCalledTimes(2);
  expect(download.mock.calls.map((c) => c[0])).toEqual([
    'https://extensions.duckdb.org/v9.9.9/wasm_eh/parquet.duckdb_extension.wasm',
    'https://extensions.duckdb.org/v9.9.9/wasm_eh/json.duckdb_extension.wasm',
  ]);
  const again = fakeDownload();
  const got = await obtainExtensions(exts(root, again));
  expect(again).not.toHaveBeenCalled();
  expect(Buffer.from(got.parquet)).toEqual(Buffer.from(PQ));
});

test('a cache file that no longer verifies is downloaded again', async () => {
  const { root } = fakeDist();
  await obtainExtensions(exts(root));
  writeFileSync(join(root, 'cache', 'json.duckdb_extension.wasm'), 'corrupt');
  const download = fakeDownload();
  const got = await obtainExtensions(exts(root, download));
  expect(download).toHaveBeenCalledTimes(1);
  expect(Buffer.from(got.json)).toEqual(Buffer.from(JS));
});

test('a download that does not match its pin fails naming the file and both hashes, and is not cached', async () => {
  const { root } = fakeDist();
  const bad = new Uint8Array(10).fill(9);
  const download = vi.fn(async () => bad);
  const err = await obtainExtensions(exts(root, download)).catch((e: unknown) => e as Error);
  expect(err).toBeInstanceOf(Error);
  const msg = (err as Error).message;
  expect(msg).toContain('https://extensions.duckdb.org/v9.9.9/wasm_eh/parquet.duckdb_extension.wasm');
  expect(msg).toContain(sha(bad));
  expect(msg).toContain(PINS.sha256.parquet);
  expect(existsSync(join(root, 'cache', 'parquet.duckdb_extension.wasm'))).toBe(false);
});

test('a local directory is used with no download and verified against the pins', async () => {
  const { root } = fakeDist();
  const dir = join(root, 'local');
  mkdirSync(dir);
  writeFileSync(join(dir, 'parquet.duckdb_extension.wasm'), PQ);
  writeFileSync(join(dir, 'json.duckdb_extension.wasm'), JS);
  const download = fakeDownload();
  const got = await obtainExtensions({ ...exts(root, download), localDir: dir });
  expect(download).not.toHaveBeenCalled();
  expect(Buffer.from(got.json)).toEqual(Buffer.from(JS));
  writeFileSync(join(dir, 'json.duckdb_extension.wasm'), 'tampered');
  await expect(obtainExtensions({ ...exts(root, download), localDir: dir })).rejects.toThrow(
    /json\.duckdb_extension\.wasm: SHA-256 is .* pins /,
  );
});
