import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, test } from 'vitest';
import { buildEngineAssets } from '../../scripts/engine-assets.js';
import { ENGINE_VERSION, engineAssetNames } from '../../src/writer/engine-assets.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeDist(): { dist: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'engine-assets-'));
  dirs.push(root);
  const dist = join(root, 'dist');
  const out = join(root, 'assets');
  mkdirSync(dist);
  mkdirSync(out);
  writeFileSync(join(dist, 'duckdb-eh.wasm'), new Uint8Array(5000).fill(7));
  writeFileSync(join(dist, 'duckdb-browser-eh.worker.js'), 'console.log("worker");');
  return { dist, out };
}

test('writes the four engine files named by the package version', () => {
  const { dist, out } = fakeDist();
  const names = buildEngineAssets({ distDir: dist, outDir: out });
  expect([...names].sort()).toEqual([...engineAssetNames('site'), ...engineAssetNames('local')].sort());
  expect(names.every((n) => n.startsWith(`duckdb.${ENGINE_VERSION}.`))).toBe(true);
  expect(readFileSync(join(out, `duckdb.${ENGINE_VERSION}.wasm`))).toEqual(
    readFileSync(join(dist, 'duckdb-eh.wasm')),
  );
  expect(readFileSync(join(out, `duckdb.${ENGINE_VERSION}.worker.js`), 'utf8')).toBe(
    'console.log("worker");',
  );
});

test('the b64 wrappers push gzip (wasm) and plain (worker) base64 under the engine keys', () => {
  const { dist, out } = fakeDist();
  buildEngineAssets({ distDir: dist, outDir: out });
  const wasm = readFileSync(join(out, `duckdb.${ENGINE_VERSION}.wasm.gz.b64.js`), 'utf8');
  const m = /^__OH__\.push\("engine\/wasm\.gz","([A-Za-z0-9+/=]+)"\);?\n?$/.exec(wasm);
  expect(m).not.toBeNull();
  expect(gunzipSync(Buffer.from(m?.[1] ?? '', 'base64'))).toEqual(readFileSync(join(dist, 'duckdb-eh.wasm')));
  const worker = readFileSync(join(out, `duckdb.${ENGINE_VERSION}.worker.b64.js`), 'utf8');
  const w = /^__OH__\.push\("engine\/worker","([A-Za-z0-9+/=]+)"\);?\n?$/.exec(worker);
  expect(Buffer.from(w?.[1] ?? '', 'base64').toString('utf8')).toBe('console.log("worker");');
});

test('the real package files stay near the spike sizes (9.8 MB gzip+base64, 34 MB plain)', () => {
  const root = mkdtempSync(join(tmpdir(), 'engine-assets-real-'));
  dirs.push(root);
  buildEngineAssets({ outDir: root });
  const size = (n: string) => readFileSync(join(root, n)).length;
  const near = (actual: number, expected: number) => Math.abs(actual - expected) / expected < 0.1;
  expect(near(size(`duckdb.${ENGINE_VERSION}.wasm.gz.b64.js`), 9.8e6)).toBe(true);
  expect(near(size(`duckdb.${ENGINE_VERSION}.wasm`), 34e6)).toBe(true);
});
