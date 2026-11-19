import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createReportWith, resolveDeps } from '../../../src/api/report.js';
import { assetsBaseFor } from '../../../src/cli/ci/site.js';
import {
  ensureSharedAssets,
  migrateAssetsBases,
  pruneAssets,
  referencedAssets,
} from '../../../src/cli/ci/site-assets.js';
import { engineAssetNames } from '../../../src/format/engine.js';
import type { WriterDeps } from '../../../src/writer/session.js';
import { upgradeReport } from '../../../src/writer/upgrade.js';
import { fakeViewerAssets } from '../../../test-support/writer-deps.js';

let dir: string;
let site: string;
let deps: WriterDeps;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'site-assets-'));
  site = join(dir, 'site');
  mkdirSync(site);
  deps = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A site-format report at `<site>/<rel>` whose viewer files are at `assetsBase`. */
async function reportAt(rel: string, assetsBase: string): Promise<string> {
  const out = join(dir, `src-${rel.replace(/\W/g, '_')}`);
  const r = await createReportWith({ out, format: 'site', assetsBase }, deps);
  await r.close();
  await upgradeReport(deps, out, { format: 'site', assetsBase });
  const to = join(site, rel);
  mkdirSync(join(to, '..'), { recursive: true });
  const { cpSync } = await import('node:fs');
  cpSync(out, to, { recursive: true });
  return to;
}

const flatSet = (): string[] => [
  'assets/viewer.abc123.js',
  'assets/viewer.abc123.css',
  ...engineAssetNames('site').map((n) => `assets/${n}`),
];
const warnings = (): { warn: (m: string) => void; all: string[] } => {
  const all: string[] = [];
  return { warn: (m) => all.push(m), all };
};

describe('ensureSharedAssets', () => {
  test('writes the viewer and site engine files flat, once, and sweeps .tmp- leftovers', async () => {
    mkdirSync(join(site, 'assets', '.x.tmp-1'), { recursive: true });
    writeFileSync(join(site, 'assets', 'viewer.abc123.js'), 'mine');
    writeFileSync(join(site, 'assets', 'viewer.abc123.js.tmp-1'), 'x');
    await ensureSharedAssets(site, deps);
    for (const p of flatSet()) expect(existsSync(join(site, p))).toBe(true);
    expect(existsSync(join(site, 'assets', '9.9.9'))).toBe(false);
    expect(readFileSync(join(site, 'assets', 'viewer.abc123.js'), 'utf8')).toBe('mine');
    expect(existsSync(join(site, 'assets', '.x.tmp-1'))).toBe(false);
    expect(existsSync(join(site, 'assets', 'viewer.abc123.js.tmp-1'))).toBe(false);
  });
});

describe('referencedAssets', () => {
  test('the page hrefs and the manifest engine names of a report on the flat base', async () => {
    await reportAt('branch/main', assetsBaseFor('branch/main'));
    const w = warnings();
    expect(await referencedAssets(site, deps, w.warn)).toEqual(new Set(flatSet()));
    expect(w.all).toEqual([]);
  });

  test('a versioned base references its folder whole; an href outside assets/ is ignored', async () => {
    const to = await reportAt('branch/main', '../../assets/0.7.0/');
    const page = join(to, 'index.html');
    writeFileSync(
      page,
      `${readFileSync(page, 'utf8')}<script src="../../x.js"></script><script src="../../assets/../y.js"></script>`,
    );
    const set = await referencedAssets(site, deps, () => {});
    expect(set?.has('assets/0.7.0/')).toBe(true);
    expect([...(set ?? [])].some((p) => p.includes('x.js') || p.includes('y.js'))).toBe(false);
  });

  test('is null, with a warning, when a report manifest is unreadable', async () => {
    mkdirSync(join(site, 'pr/3/data'), { recursive: true });
    writeFileSync(join(site, 'pr/3/data/manifest.js'), 'not a manifest');
    const w = warnings();
    expect(await referencedAssets(site, deps, w.warn)).toBeNull();
    expect(w.all).toHaveLength(1);
  });
});

describe('pruneAssets', () => {
  test('lists the unreferenced files under assets/ at any depth and removes nothing', async () => {
    await reportAt('branch/main', assetsBaseFor('branch/main'));
    await ensureSharedAssets(site, deps);
    mkdirSync(join(site, 'assets', '0.6.0'), { recursive: true });
    writeFileSync(join(site, 'assets', 'viewer.old.js'), 'x');
    writeFileSync(join(site, 'assets', '0.6.0', 'viewer.z.js'), 'x');
    const listed = await pruneAssets(site, deps);
    expect(listed.sort()).toEqual(['assets/0.6.0/viewer.z.js', 'assets/viewer.old.js']);
    expect(existsSync(join(site, 'assets', 'viewer.old.js'))).toBe(true);
    expect(existsSync(join(site, 'assets', '0.6.0', 'viewer.z.js'))).toBe(true);
  });
});

describe('migrateAssetsBases', () => {
  const fillVersion = (v: string, skip?: string): void => {
    mkdirSync(join(site, 'assets', v), { recursive: true });
    for (const p of flatSet()) {
      const name = p.slice('assets/'.length);
      if (name !== skip) writeFileSync(join(site, 'assets', v, name), name);
    }
  };

  test('copies the referenced files flat, rewrites the page and the manifest base once, and is a no-op after', async () => {
    const to = await reportAt('branch/main', '../../assets/9.9.9/');
    fillVersion('9.9.9');
    const before = readFileSync(join(to, 'data/manifest.js'), 'utf8');
    const w = warnings();
    expect(await migrateAssetsBases(site, deps, w.warn)).toEqual(['branch/main']);
    expect(w.all).toEqual([]);
    expect(readFileSync(join(to, 'index.html'), 'utf8')).toContain('"../../assets/viewer.');
    const after = readFileSync(join(to, 'data/manifest.js'), 'utf8');
    expect(after).toContain('"assetsBase":"../../assets/"');
    expect(after).toBe(before.replace('"assetsBase":"../../assets/9.9.9/"', '"assetsBase":"../../assets/"'));
    expect(existsSync(join(site, 'assets', 'viewer.abc123.js'))).toBe(true);
    expect(await referencedAssets(site, deps, () => {})).toEqual(new Set(flatSet()));
    expect(await migrateAssetsBases(site, deps, w.warn)).toEqual([]);
  });

  test('skips a report whose manifest text holds the base twice or whose version folder lacks a file', async () => {
    const twice = await reportAt('branch/a', '../../assets/9.9.9/');
    const lacking = await reportAt('branch/b', '../../assets/9.9.9/');
    fillVersion('9.9.9', 'viewer.abc123.css');
    const m = join(twice, 'data/manifest.js');
    writeFileSync(m, `${readFileSync(m, 'utf8')}\n// "assetsBase":"../../assets/9.9.9/"`);
    const keep = [readFileSync(m, 'utf8'), readFileSync(join(lacking, 'data/manifest.js'), 'utf8')];
    const w = warnings();
    expect(await migrateAssetsBases(site, deps, w.warn)).toEqual([]);
    expect(w.all).toHaveLength(2);
    expect([readFileSync(m, 'utf8'), readFileSync(join(lacking, 'data/manifest.js'), 'utf8')]).toEqual(keep);
  });
});

describe('assetsBaseFor', () => {
  test('names the flat folder from the report path', () => {
    expect(assetsBaseFor('branch/main')).toBe('../../assets/');
    expect(assetsBaseFor('pr/5/runs/7')).toBe('../../../../assets/');
  });
});

describe('engineAssetNames', () => {
  test('names another version on request', () => {
    expect(engineAssetNames('site', '1.2.3')).toContain('duckdb.1.2.3.wasm');
    expect(engineAssetNames('site', '1.2.3')).toContain('parquet.1.2.3.duckdb_extension.wasm');
  });
});
