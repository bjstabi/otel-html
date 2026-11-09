import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tableFromIPC } from 'apache-arrow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostError, policyStatements, startHostEngine, wrapStatement } from '../../src/host/engine.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { buildFormat4Report, spansOnlyRequest } from '../../test-support/format4-fixture.js';
import { packageHostEngineFiles } from '../../test-support/host-engine-files.js';
import { writeReportDir } from '../../test-support/report-dir.js';

// A real engine start takes about 0.5 s here and several times that on a CI runner; restarts start a second one.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function started() {
  const fixture = await buildFormat4Report([spansOnlyRequest(3), spansOnlyRequest(2)], { close: false });
  const report = await writeReportDir(fixture);
  cleanups.push(report.close);
  const engine = await startHostEngine({
    report: report.dir,
    manifest: fixture.manifest,
    files: packageHostEngineFiles(),
    fs: createNodeFileSystem(),
    logger,
    timeoutMs: 30_000,
    maxResultBytes: 64 * 1024 * 1024,
  });
  cleanups.push(() => engine.close());
  return { engine, dir: report.dir };
}

const rows = (bytes: Uint8Array): { value?: unknown; n?: unknown }[] =>
  tableFromIPC(bytes)
    .toArray()
    .map((r: { toJSON(): { value?: unknown; n?: unknown } }) => r.toJSON());

describe('the engine policy', () => {
  it('lists the statements in the order of D37, allowing exactly the manifest-listed paths', async () => {
    const fixture = await buildFormat4Report([spansOnlyRequest(3), spansOnlyRequest(2)], { close: false });
    const listed = fixture.manifest.partitions.flatMap((q) => Object.values(q.files).map((f) => f.path));
    expect(listed.length).toBeGreaterThan(0);
    expect(policyStatements(fixture.manifest)).toEqual([
      'SET autoinstall_known_extensions = false',
      'SET autoload_known_extensions = false',
      `SET allowed_paths = [${listed.map((l) => `'${l.replaceAll("'", "''")}'`).join(', ')}]`,
      'SET enable_external_access = false',
      'SET lock_configuration = true',
    ]);
  });

  it('refuses unregistered files under data/partitions/ even by a name relative to the working directory', async () => {
    const { engine, dir } = await started();
    const decoy = await mkdtemp(join(tmpdir(), 'otel-html-decoy-'));
    const before = process.cwd();
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(decoy, 'data/partitions/sub'), { recursive: true });
      await writeFile(join(decoy, 'data/partitions/secret.txt'), 'secret');
      await writeFile(join(decoy, 'data/partitions/sub/x.txt'), 'x');
      await copyFile(
        join(dir, 'data/partitions/000001/spans.parquet'),
        join(decoy, 'data/partitions/extra.parquet'),
      );
      process.chdir(decoy);
      for (const sql of [
        "SELECT * FROM read_text('data/partitions/secret.txt')",
        "SELECT * FROM read_text('data/partitions/sub/x.txt')",
        "SELECT * FROM glob('data/partitions/**')",
        "SELECT * FROM read_parquet('data/partitions/extra.parquet')",
      ]) {
        const error = await engine.query(sql).catch((e: unknown) => e);
        expect(error, sql).toMatchObject({ status: 400 });
        expect((error as HostError).message, sql).toMatch(/Permission Error/);
      }
      expect(rows(await engine.query('SELECT count(*) AS n FROM spans'))).toEqual([{ n: 5n }]);
    } finally {
      process.chdir(before);
      await rm(decoy, { recursive: true, force: true });
    }
  }, 20_000);

  it('wraps a statement so only a query runs', () => {
    expect(wrapStatement('SELECT 1')).toBe('SELECT * FROM (\nSELECT 1\n) AS otel_host');
  });

  it('refuses each statement with a 400, and the engine answers right after', async () => {
    const { engine, dir } = await started();
    const spansPath = join(dir, 'data/partitions/000001/spans.parquet');
    const refused = [
      'CREATE TABLE t AS SELECT 1',
      'SELECT 1; SELECT 2',
      'SET threads = 1',
      'LOAD icu',
      "COPY (SELECT 1) TO '/tmp/x.csv'",
      "ATTACH '/tmp/x.db' AS o",
      "SELECT * FROM read_csv('/etc/passwd')",
      `SELECT * FROM read_parquet('${spansPath}')`,
      'SELECT 1) AS a; CREATE TABLE t AS SELECT 1; SELECT * FROM (SELECT 1',
      'SELECT 1) AS a; DROP VIEW spans; SELECT * FROM (SELECT 1',
    ];
    for (const sql of refused) {
      const t0 = performance.now();
      const error = await engine.query(sql).catch((e: unknown) => e);
      expect(performance.now() - t0, `${sql} returns well inside the timeout`).toBeLessThan(5_000);
      expect(error, sql).toBeInstanceOf(HostError);
      expect(error, sql).toMatchObject({ status: 400 });
      expect((error as HostError).message, sql).toMatch(/Parser Error|Permission Error|Invalid Input Error/);
      expect(rows(await engine.query('SELECT count(*) AS n FROM spans'))).toEqual([{ n: 5n }]);
    }
  }, 20_000);

  it('answers the next statement within a second after a refusal (@perf)', async () => {
    const { engine } = await started();
    await engine.query('SET threads = 1').catch(() => undefined);
    const t = performance.now();
    expect(rows(await engine.query('SELECT count(*) AS n FROM spans'))).toEqual([{ n: 5n }]);
    const ms = performance.now() - t;
    process.stdout.write(`policy: next statement after a refusal ${ms.toFixed(0)} ms\n`);
    expect(ms).toBeLessThan(1_000);
  });

  it('writes nothing to stdout when a statement is refused', async () => {
    const { engine } = await started();
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await engine.query('SELECT * FROM nope').catch(() => undefined);
      await engine.query('SELECT 1');
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.stdout.write = original;
    }
    expect(written.join('')).toBe('');
  });

  it('keeps ORDER BY of the wrapped statement', async () => {
    const { engine } = await started();
    const out = rows(
      await engine.query('WITH r AS (SELECT range AS x FROM range(10)) SELECT x FROM r ORDER BY x DESC'),
    );
    expect(out.slice(0, 3)).toEqual([{ x: 9n }, { x: 8n }, { x: 7n }]);
  });

  it('has external access off and the configuration locked', async () => {
    const { engine } = await started();
    const v = async (name: string) =>
      rows(await engine.query(`SELECT current_setting('${name}') AS value`))[0]?.value;
    expect(await v('enable_external_access')).toBe(false);
    expect(await v('lock_configuration')).toBe(true);
  });
});
