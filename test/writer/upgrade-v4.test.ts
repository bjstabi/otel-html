import { describe, expect, test } from 'vitest';
import { runCli } from '../../src/cli/program.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { ENGINE_VERSION, engineAssetNames } from '../../src/format/engine.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { ENGINE_ASSET_RE, MANIFEST_KEY, partitionWrapperPath } from '../../src/format/paths.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { openSession } from '../../src/writer/session.js';
import { upgradeReport } from '../../src/writer/upgrade.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { spansRequest } from './helpers.js';

type Format = 'local' | 'site';

/** The report's engine files (the wasm, the worker and the extensions), sorted. */
const engineFiles = (w: TestWriter): string[] =>
  [...w.fs.snapshot().keys()].filter((k) => ENGINE_ASSET_RE.test(k.slice('r/'.length))).sort();

async function v4Report(w: TestWriter, out: string, format: Format, extra: object = {}): Promise<void> {
  for (const [i, r] of [spansRequest(3), spansRequest(2, 10_000, 10)].entries()) {
    const s = await openSession(w.deps, {
      out,
      config: testConfig({ writer: { format, ...extra } }),
      mode: i === 0 ? 'replace' : 'append',
    });
    await s.add(otlp(r), `in-${i}.json`);
    await s.close();
  }
}

function manifestV4(w: TestWriter, out: string): ManifestV4 {
  const text = w.fs.snapshot().get(`${out}/data/manifest.js`);
  if (text === undefined) throw new Error('no manifest');
  const m = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(m)) throw new Error('not v4');
  return m;
}

const listed = (m: ManifestV4): { n: number; table: string; path: string }[] =>
  m.partitions.flatMap((p) => Object.entries(p.files).map(([table, f]) => ({ n: p.n, table, path: f.path })));

const files = (w: TestWriter, prefix: string): string[] =>
  [...w.fs.snapshot().keys()].filter((k) => k.startsWith(prefix)).sort();

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('upgradeReport on a format-4 report', () => {
  test('without options it rewrites the viewer and keeps format and data', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    const before = manifestV4(w, 'r');
    await w.fs.writeBytes('r/assets/duckdb.0.9.0.wasm', new Uint8Array([1]));
    await w.fs.writeTextAtomic('r/index.html', '<html>old</html>');
    const r = await upgradeReport(w.deps, 'r');
    expect(r.formatVersion).toBe(4);
    expect(manifestV4(w, 'r')).toEqual({
      ...before,
      engine: { ...before.engine, version: ENGINE_VERSION },
    });
    expect(w.fs.snapshot().get('r/index.html')).toContain('assets/viewer.abc123.js');
    expect(files(w, 'r/assets/')).toContain(`r/assets/${engineAssetNames('site')[0]}`);
    expect(files(w, 'r/assets/')).not.toContain('r/assets/duckdb.0.9.0.wasm');
    expect(files(w, 'r/data/state/lock')).toEqual([]);
  });

  test('site to local adds a wrapper per Parquet file and the base64 engine, and flips engine.format', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    const parquet = await Promise.all(listed(manifestV4(w, 'r')).map((l) => w.fs.readBytes(`r/${l.path}`)));
    await upgradeReport(w.deps, 'r', { format: 'local' });
    const m = manifestV4(w, 'r');
    expect(m.engine.format).toBe('local');
    const l = listed(m);
    expect(l.length).toBeGreaterThan(0);
    for (const [i, f] of l.entries()) {
      expect(w.fs.snapshot().get(`r/${f.path}.js`)).toContain(
        `partitions/${String(f.n).padStart(6, '0')}/${f.table}`,
      );
      expect(await w.fs.readBytes(`r/${f.path}`)).toEqual(parquet[i]);
      expect(`${f.path}.js`).toBe(partitionWrapperPath(f.n, f.table as never));
    }
    const assets = engineFiles(w);
    expect(assets).toEqual(
      engineAssetNames('local')
        .map((n) => `r/assets/${n}`)
        .sort(),
    );
  });

  test('local to site removes the wrappers and the base64 engine, and flips engine.format', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'local');
    expect(files(w, 'r/data/partitions').some((p) => p.endsWith('.parquet.js'))).toBe(true);
    await upgradeReport(w.deps, 'r', { format: 'site' });
    expect(manifestV4(w, 'r').engine.format).toBe('site');
    expect(files(w, 'r/data/partitions').some((p) => p.endsWith('.parquet.js'))).toBe(false);
    expect(files(w, 'r/data/partitions').filter((p) => p.endsWith('.parquet')).length).toBe(
      listed(manifestV4(w, 'r')).length,
    );
    expect(engineFiles(w)).toEqual(
      engineAssetNames('site')
        .map((n) => `r/assets/${n}`)
        .sort(),
    );
  });

  test('site to local that dies before the manifest leaves extra files, not missing ones', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    w.fs.failNextWrite('data/manifest.js');
    await expect(upgradeReport(w.deps, 'r', { format: 'local' })).rejects.toThrow();
    expect(manifestV4(w, 'r').engine.format).toBe('site');
    for (const f of listed(manifestV4(w, 'r'))) expect(w.fs.snapshot().has(`r/${f.path}.js`)).toBe(true);
    expect(engineFiles(w)).toEqual(
      expect.arrayContaining(
        [...engineAssetNames('site'), ...engineAssetNames('local')].map((n) => `r/assets/${n}`),
      ),
    );
    expect(files(w, 'r/data/state/lock')).toEqual([]);
  });

  test('local to site that dies before the manifest keeps the wrappers', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'local');
    w.fs.failNextWrite('data/manifest.js');
    await expect(upgradeReport(w.deps, 'r', { format: 'site' })).rejects.toThrow();
    expect(manifestV4(w, 'r').engine.format).toBe('local');
    for (const f of listed(manifestV4(w, 'r'))) expect(w.fs.snapshot().has(`r/${f.path}.js`)).toBe(true);
  });

  test('a shared --assets-base rewrites index.html and the manifest, and removes the own engine and viewer files', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    await w.fs.writeBytes('r/assets/0.3.0/keep.js', new Uint8Array([1]));
    await upgradeReport(w.deps, 'r', { assetsBase: '../../assets/0.3.0/' });
    expect(manifestV4(w, 'r').engine.assetsBase).toBe('../../assets/0.3.0/');
    expect(w.fs.snapshot().get('r/index.html')).toContain('../../assets/0.3.0/viewer.abc123.js');
    expect(files(w, 'r/assets/')).toEqual(['r/assets/0.3.0/keep.js']);
  });

  test('a shared base together with a format change writes no engine files beside the report', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    await upgradeReport(w.deps, 'r', { format: 'local', assetsBase: '../assets/' });
    const m = manifestV4(w, 'r');
    expect(m.engine).toMatchObject({ format: 'local', assetsBase: '../assets/' });
    expect(files(w, 'r/assets/')).toEqual([]);
    for (const f of listed(m)) expect(w.fs.snapshot().has(`r/${f.path}.js`)).toBe(true);
  });

  test('moving back to assets/ writes the report its own viewer files again', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site', { assetsBase: '../assets/' });
    expect(files(w, 'r/assets/')).toEqual([]);
    await upgradeReport(w.deps, 'r', { assetsBase: 'assets/' });
    expect(manifestV4(w, 'r').engine.assetsBase).toBe('assets/');
    expect(files(w, 'r/assets/')).toContain('r/assets/viewer.abc123.js');
  });

  test('a bad --assets-base is a usage error and nothing is written', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    const before = new Map(w.fs.snapshot());
    const e = await failure(upgradeReport(w.deps, 'r', { assetsBase: 'https://x/' }));
    expect(e.code).toBe('usage');
    expect(w.fs.snapshot()).toEqual(before);
  });

  test('a locked report is refused and nothing is written', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    await w.fs.writeTextAtomic(
      'r/data/state/lock.json',
      JSON.stringify({ pid: 4242, hostname: 'host-a', startedAt: 'now' }),
    );
    const before = new Map(w.fs.snapshot());
    const e = await failure(upgradeReport(w.deps, 'r', { format: 'local' }));
    expect(e.code).toBe('usage');
    expect(w.fs.snapshot()).toEqual(before);
  });
});

describe('upgradeReport fix round 1', () => {
  test('an append that commits between the first read and the lock survives the upgrade', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    const count = async (): Promise<number> => {
      let n = 0;
      for (const p of manifestV4(w, 'r').partitions) {
        const f = p.files.spans;
        if (f !== undefined) n += decodeTable('spans', await w.fs.readBytes(`r/${f.path}`)).length;
      }
      return n;
    };
    const before = await count();
    let appended = false;
    const fs = {
      ...w.fs,
      async createExclusive(p: string, text: string) {
        if (!appended && p.endsWith('lock.json')) {
          appended = true;
          const s = await openSession(w.deps, {
            out: 'r',
            config: testConfig({ writer: { format: 'site' } }),
            mode: 'append',
          });
          await s.add(otlp(spansRequest(4, 50_000, 30)), 'late.json');
          await s.close();
        }
        return w.fs.createExclusive(p, text);
      },
    };
    await upgradeReport({ ...w.deps, fs }, 'r', { format: 'local' });
    expect(appended).toBe(true);
    expect(await count()).toBe(before + 4);
    for (const f of listed(manifestV4(w, 'r'))) {
      expect(w.fs.snapshot().has(`r/${f.path}`)).toBe(true);
      expect(w.fs.snapshot().has(`r/${f.path}.js`)).toBe(true);
    }
  });

  test.each([
    ['upgrade --format site', { format: 'site' as const }],
    ['a plain upgrade', {}],
  ])('%s removes wrappers a crashed local-to-site upgrade left', async (_n, opts) => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'local');
    const wrappers = listed(manifestV4(w, 'r')).map((f) => `r/${f.path}.js`);
    // The crash: the manifest says site, the wrappers are still there.
    await upgradeReport(w.deps, 'r', { format: 'site' });
    for (const p of wrappers) await w.fs.writeTextAtomic(p, 'stray');
    await upgradeReport(w.deps, 'r', opts);
    for (const p of wrappers) expect(w.fs.snapshot().has(p)).toBe(false);
  });

  test('older viewer files are removed from the default base and a subfolder is kept', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    await w.fs.writeBytes('r/assets/viewer.OLDHASH.js', new Uint8Array([1]));
    await w.fs.writeBytes('r/assets/viewer.OLDHASH.css', new Uint8Array([1]));
    await w.fs.writeBytes('r/assets/0.3.0/viewer.x.js', new Uint8Array([1]));
    await upgradeReport(w.deps, 'r');
    const names = files(w, 'r/assets/');
    expect(names).not.toContain('r/assets/viewer.OLDHASH.js');
    expect(names).not.toContain('r/assets/viewer.OLDHASH.css');
    expect(names).toContain('r/assets/viewer.abc123.js');
    expect(names).toContain('r/assets/0.3.0/viewer.x.js');
  });

  test('a report on a shared base needs --assets-base, and nothing is written without it', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site', { assetsBase: '../assets/' });
    const before = new Map(w.fs.snapshot());
    const e = await failure(upgradeReport(w.deps, 'r', { format: 'local' }));
    expect(e.code).toBe('usage');
    expect(e.hint).toContain('--assets-base');
    expect(w.fs.snapshot()).toEqual(before);
    await upgradeReport(w.deps, 'r', { assetsBase: '../assets/' });
    expect(manifestV4(w, 'r').engine.assetsBase).toBe('../assets/');
    expect(files(w, 'r/assets/')).toEqual([]);
  });

  test('a symlinked assets folder is refused and nothing is written', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    const before = new Map(w.fs.snapshot());
    const fs = {
      ...w.fs,
      realpath: async (p: string) => (p === 'r/assets' ? '/elsewhere/assets' : w.fs.realpath(p)),
    };
    const e = await failure(upgradeReport({ ...w.deps, fs }, 'r', { format: 'local' }));
    expect(e.code).toBe('invalid-report');
    expect(w.fs.snapshot()).toEqual(before);
  });

  test('a crash partway through the wrappers is finished by running the upgrade again', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    const all = listed(manifestV4(w, 'r'));
    expect(all.length).toBeGreaterThan(1);
    w.fs.failNextWrite(`${all[1]?.path}.js`);
    await expect(upgradeReport(w.deps, 'r', { format: 'local' })).rejects.toThrow();
    expect(manifestV4(w, 'r').engine.format).toBe('site');
    await upgradeReport(w.deps, 'r', { format: 'local' });
    expect(manifestV4(w, 'r').engine.format).toBe('local');
    for (const f of all) expect(w.fs.snapshot().has(`r/${f.path}.js`)).toBe(true);
    expect(files(w, 'r/data/state/lock')).toEqual([]);
  });
});

describe('upgradeReport fix round 2', () => {
  /** A fs whose lock creation first runs `during`: the report changes between upgrade's first read and its lock. */
  function racing(w: TestWriter, during: () => Promise<void>) {
    let ran = false;
    return {
      ...w.fs,
      async createExclusive(p: string, text: string) {
        if (!ran && p.endsWith('lock.json')) {
          ran = true;
          await during();
        }
        return w.fs.createExclusive(p, text);
      },
    };
  }

  test('a chunks report replaced by a format-4 one before the lock is refused and its assets are untouched', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config: testConfig(), mode: 'replace' });
    await s.add(otlp(spansRequest(1)), 'in.json');
    await s.close();
    let after = new Map<string, string>();
    const fs = racing(w, async () => {
      await v4Report(w, 'r', 'site');
      after = new Map(w.fs.snapshot());
    });
    const e = await failure(upgradeReport({ ...w.deps, fs }, 'r'));
    expect(e.code).toBe('usage');
    expect(e.hint).toContain('run upgrade again');
    expect(w.fs.snapshot()).toEqual(after);
    expect(engineFiles(w).length).toBeGreaterThan(0);
    expect(files(w, 'r/data/state/lock')).toEqual([]);
  });

  test('a base that became shared before the lock needs --assets-base and the lock is released', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    let after = new Map<string, string>();
    const fs = racing(w, async () => {
      await v4Report(w, 'r', 'site', { assetsBase: '../assets/' });
      after = new Map(w.fs.snapshot());
    });
    const e = await failure(upgradeReport({ ...w.deps, fs }, 'r'));
    expect(e.code).toBe('usage');
    expect(e.hint).toContain('--assets-base');
    expect(w.fs.snapshot()).toEqual(after);
    expect(files(w, 'r/data/state/lock')).toEqual([]);
  });
});

describe('upgradeReport on a chunks report', () => {
  test('--format and --assets-base are a usage error that points to merge', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'c', config: testConfig(), mode: 'replace' });
    await s.add(otlp(spansRequest(1)), 'in.json');
    await s.close();
    const before = new Map(w.fs.snapshot());
    const e = await failure(upgradeReport(w.deps, 'c', { format: 'site' }));
    expect(e.code).toBe('usage');
    expect(e.hint).toContain('merge');
    expect((await failure(upgradeReport(w.deps, 'c', { assetsBase: '../assets/' }))).code).toBe('usage');
    expect(w.fs.snapshot()).toEqual(before);
  });

  test('an unreadable formatVersion does not tell upgrade to merge', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'c', config: testConfig(), mode: 'replace' });
    await s.close();
    const text = w.fs.snapshot().get('c/data/manifest.js') ?? '';
    await w.fs.writeTextAtomic(
      'c/data/manifest.js',
      text.replace(/"formatVersion":\s*3/, '"formatVersion":9'),
    );
    const e = await failure(upgradeReport(w.deps, 'c'));
    expect(e.code).toBe('version-mismatch');
    expect(e.hint).not.toMatch(/merge/);
    expect(e.message).toContain('1, 2, 3, 4');
  });
});

describe('otel-html upgrade --format --assets-base', () => {
  test('flags reach upgradeReport', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    let out = '';
    const code = await runCli(
      ['upgrade', 'r', '--format', 'local', '--assets-base', '../../assets/0.3.0/'],
      {
        stdout: (s) => {
          out += s;
        },
        stderr: () => undefined,
        env: {},
        cwd: '/work',
        signals: { on: () => () => undefined },
        spawn: () => {
          throw new Error('no spawn');
        },
      },
      w.deps,
    );
    expect(code).toBe(0);
    expect(out).toMatch(/^upgraded r: viewer \S+, format 4\n$/);
    expect(manifestV4(w, 'r').engine).toMatchObject({ format: 'local', assetsBase: '../../assets/0.3.0/' });
  });
});

describe('upgrade --format local size warning (R52)', () => {
  const warns = (w: TestWriter) => w.logs.filter((l) => l.level === 'warn' && l.msg.includes('local report'));

  test('warns when the Parquet bytes pass localWarnBytes, and not when they do not', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'site');
    await upgradeReport(w.deps, 'r', { format: 'local' });
    expect(warns(w)).toHaveLength(0);
    const w2 = createTestWriter();
    await v4Report(w2, 'r', 'site');
    await upgradeReport(w2.deps, 'r', { format: 'local', localWarnBytes: 1 });
    expect(warns(w2)).toHaveLength(1);
    expect(warns(w2)[0]?.msg).toContain('--format site');
  });

  test('a site upgrade never warns', async () => {
    const w = createTestWriter();
    await v4Report(w, 'r', 'local');
    await upgradeReport(w.deps, 'r', { format: 'site', localWarnBytes: 1 });
    expect(warns(w)).toHaveLength(0);
  });
});
