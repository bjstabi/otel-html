import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  ENGINE_EXTENSIONS,
  ENGINE_VERSION,
  engineAssetNames,
  engineExtensionName,
} from '../../src/format/engine.js';
import { ENGINE_ASSET_RE } from '../../src/format/paths.js';
import { openSession } from '../../src/writer/session.js';
import { type ViewerAsset, withEngineFiles } from '../../src/writer/viewer-assets.js';
import { openTestDb } from '../../test-support/duckdb-node.js';
import { logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  devDependencies: Record<string, string>;
};

describe('engine assets', () => {
  test('the pinned extension core version is the one the installed engine reports', async () => {
    const pins = JSON.parse(
      readFileSync(new URL('../../scripts/duckdb-extensions.json', import.meta.url), 'utf8'),
    ) as { core: string; platform: string };
    const db = await openTestDb();
    try {
      expect(db.rows('select library_version v from pragma_version()')).toEqual([{ v: pins.core }]);
    } finally {
      db.close();
    }
    expect(pins.platform).toBe('wasm_eh');
  });

  test('DuckDB names an extension by the part of the file name before the first dot', () => {
    for (const e of ENGINE_EXTENSIONS) {
      expect(engineExtensionName('site', e).split('.')[0]).toBe(e);
      expect(engineExtensionName('site', e)).toContain(`.${ENGINE_VERSION}.`);
    }
  });

  test('ENGINE_VERSION is the installed @duckdb/duckdb-wasm version, pinned in package.json', () => {
    expect(pkg.devDependencies['@duckdb/duckdb-wasm']).toBe(ENGINE_VERSION);
    const installed = JSON.parse(
      readFileSync(new URL('../../node_modules/@duckdb/duckdb-wasm/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(installed.version).toBe(ENGINE_VERSION);
  });

  test('site reports get the plain files, local reports the base64 wrappers', () => {
    expect(engineAssetNames('site')).toEqual([
      `duckdb.${ENGINE_VERSION}.wasm`,
      `duckdb.${ENGINE_VERSION}.worker.js`,
      `parquet.${ENGINE_VERSION}.duckdb_extension.wasm`,
      `json.${ENGINE_VERSION}.duckdb_extension.wasm`,
    ]);
    expect(engineAssetNames('local')).toEqual([
      `duckdb.${ENGINE_VERSION}.wasm.gz.b64.js`,
      `duckdb.${ENGINE_VERSION}.worker.b64.js`,
      `duckdb.${ENGINE_VERSION}.parquet.ext.gz.b64.js`,
      `duckdb.${ENGINE_VERSION}.json.ext.gz.b64.js`,
    ]);
  });

  test("every name matches the format's engine asset pattern", () => {
    for (const f of ['local', 'site'] as const) {
      for (const n of engineAssetNames(f)) expect(ENGINE_ASSET_RE.test(`assets/${n}`)).toBe(true);
    }
  });
});

describe('withEngineFiles', () => {
  const f = (name: string): ViewerAsset => ({ path: `assets/${name}`, contents: new Uint8Array() });
  const all = [
    f('viewer.abc.js'),
    f('viewer.abc.css'),
    ...engineAssetNames('site').map(f),
    ...engineAssetNames('local').map(f),
    f('duckdb.0.0.1.wasm'),
  ];
  const paths = (xs: readonly ViewerAsset[]) => xs.map((x) => x.path);

  test('an unspecified format keeps only the viewer files', () => {
    expect(paths(withEngineFiles(all, undefined))).toEqual(['assets/viewer.abc.js', 'assets/viewer.abc.css']);
  });

  test('local keeps the wrappers, site the plain files, and a stale version never', () => {
    expect(paths(withEngineFiles(all, 'local'))).toEqual([
      'assets/viewer.abc.js',
      'assets/viewer.abc.css',
      ...engineAssetNames('local').map((n) => `assets/${n}`),
    ]);
    expect(paths(withEngineFiles(all, 'site'))).toEqual([
      'assets/viewer.abc.js',
      'assets/viewer.abc.css',
      ...engineAssetNames('site').map((n) => `assets/${n}`),
    ]);
  });
});

describe('a session copies the engine files its format loads', () => {
  const assetFiles = async (format: 'local' | 'site') => {
    const w = createTestWriter();
    const s = await openSession(w.deps, {
      out: 'r',
      config: testConfig({ writer: { format } }),
      mode: 'replace',
    });
    await s.add(otlp(logsRequest([logRecord()])), 'a.json');
    await s.close();
    return [...w.fs.snapshot().keys()].filter((k) => k.startsWith('r/assets/')).sort();
  };
  const viewer = ['r/assets/viewer.abc123.css', 'r/assets/viewer.abc123.js'];
  const named = (format: 'local' | 'site') => engineAssetNames(format).map((n) => `r/assets/${n}`);

  test('local: the viewer files and the base64 wrappers', async () => {
    expect(await assetFiles('local')).toEqual([...named('local'), ...viewer].sort());
  });
  test('site: the viewer files and the two plain files', async () => {
    expect(await assetFiles('site')).toEqual([...named('site'), ...viewer].sort());
  });
});
