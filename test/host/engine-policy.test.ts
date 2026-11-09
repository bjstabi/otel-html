import { join } from 'node:path';
import { tableFromIPC } from 'apache-arrow';
import { afterEach, describe, expect, it } from 'vitest';
import { HostError, POLICY_STATEMENTS, startHostEngine, wrapStatement } from '../../src/host/engine.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { buildFormat4Report, spansOnlyRequest } from '../../test-support/format4-fixture.js';
import { packageHostEngineFiles } from '../../test-support/host-engine-files.js';
import { writeReportDir } from '../../test-support/report-dir.js';

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
  it('lists the statements in the order of D37', () => {
    expect(POLICY_STATEMENTS).toEqual([
      'SET autoinstall_known_extensions = false',
      'SET autoload_known_extensions = false',
      "SET allowed_directories = ['data/partitions/']",
      'SET enable_external_access = false',
      'SET lock_configuration = true',
    ]);
  });

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
      const t1 = performance.now();
      expect(rows(await engine.query('SELECT count(*) AS n FROM spans'))).toEqual([{ n: 5n }]);
      expect(performance.now() - t1, `${sql} leaves the engine answering`).toBeLessThan(1_000);
    }
  }, 20_000);

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
