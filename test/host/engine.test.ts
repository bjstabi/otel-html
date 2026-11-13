import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tableFromIPC } from 'apache-arrow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineAssetNames, engineExtensionName, engineNodeAssetNames } from '../../src/format/engine.js';
import { TABLE_COLUMNS } from '../../src/format/parquet/columns.js';
import { startHostEngine } from '../../src/host/engine.js';
import { hostEngineFiles } from '../../src/host/engine-files.js';
import { WORKER_SHIM } from '../../src/host/node-duckdb.js';
import { OtelHtmlError } from '../../src/model/errors.js';
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

async function startOver(fixtureOpts?: { dropFile?: boolean }) {
  const fixture = await buildFormat4Report([spansOnlyRequest(3), spansOnlyRequest(2)], { close: false });
  const report = await writeReportDir(fixture);
  cleanups.push(report.close);
  if (fixtureOpts?.dropFile) {
    const [first] = fixture.files.keys();
    if (first === undefined) throw new Error('no file');
    await rm(join(report.dir, first));
  }
  const engine = startHostEngine({
    report: report.dir,
    manifest: fixture.manifest,
    files: packageHostEngineFiles(),
    fs: createNodeFileSystem(),
    logger,
    timeoutMs: 30_000,
    maxResultBytes: 64 * 1024 * 1024,
  });
  return { engine, fixture };
}

async function started() {
  const { engine } = await startOver();
  const e = await engine;
  cleanups.push(() => e.close());
  return e;
}

// apache-arrow, not flechette: flechette's declarations need DOM types the node project does not have.
const rows = (bytes: Uint8Array): { column_name?: unknown; n?: unknown }[] =>
  tableFromIPC(bytes)
    .toArray()
    .map((r: { toJSON(): { column_name?: unknown; n?: unknown } }) => r.toJSON());

describe('startHostEngine', () => {
  it('counts the spans of both partitions', async () => {
    const e = await started();
    expect(rows(await e.query('SELECT count(*) AS n FROM spans'))).toEqual([{ n: 5n }]);
  });

  it('serves the rollup files of a format-5 report: span_rollups has rows, log_rollups is an empty view', async () => {
    const e = await started();
    const [spanRollups] = rows(await e.query('SELECT sum(n) AS n FROM span_rollups'));
    expect(Number(String(spanRollups?.n))).toBe(5);
    expect(rows(await e.query('SELECT count(*) AS n FROM log_rollups'))).toEqual([{ n: 0n }]);
    const sql =
      "SELECT count(*) AS n FROM span_rollups WHERE filename = 'data/partitions/000001/span_rollups.parquet'";
    expect(Number(rows(await e.query(sql))[0]?.n)).toBeGreaterThan(0);
  });

  it("has the JSON functions the viewer's SQL uses, loaded from the signed extension before the policy", async () => {
    const e = await started();
    expect(rows(await e.query(`SELECT json_extract_string('{"a":"x"}', '/a') AS v`))).toEqual([{ v: 'x' }]);
  });

  it('filename values are the manifest paths', async () => {
    const e = await started();
    const sql = "SELECT count(*) AS n FROM spans WHERE filename = 'data/partitions/000001/spans.parquet'";
    expect(rows(await e.query(sql))).toEqual([{ n: 2n }]);
  });

  it('has the logs, points and patterns views, empty, with the virtual columns last', async () => {
    const e = await started();
    for (const view of ['logs', 'points', 'patterns']) {
      expect(rows(await e.query(`SELECT count(*) AS n FROM ${view}`))).toEqual([{ n: 0n }]);
    }
    const described = rows(await e.query('DESCRIBE logs')).map((r) => r.column_name);
    expect(described).toEqual([...TABLE_COLUMNS.logs.map((c) => c.name), 'file_row_number', 'filename']);
  });

  it('rejects invalid-report naming a listed file that is missing', async () => {
    const { engine, fixture } = await startOver({ dropFile: true });
    const missing = [...fixture.files.keys()][0];
    const error = await engine.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OtelHtmlError);
    expect((error as OtelHtmlError).code).toBe('invalid-report');
    expect((error as OtelHtmlError).message).toContain(missing);
  });

  it('close() terminates the worker (the run ends with no open handle)', async () => {
    const { engine } = await startOver();
    const e = await engine;
    cleanups.push(() => e.close());
    await e.query('SELECT 1');
    await e.close();
  });
});

describe('hostEngineFiles', () => {
  const n = engineNodeAssetNames();
  const [wasm] = engineAssetNames('site');
  const parquet = engineExtensionName('site', 'parquet');
  const json = engineExtensionName('site', 'json');
  const names = [n.bindings, n.worker, wasm ?? '', parquet, json];

  it('the worker shim bridges parentPort and onmessage', () => {
    expect(WORKER_SHIM).toContain('parentPort');
    expect(WORKER_SHIM).toContain('onmessage');
  });

  it('with no dirs resolves the engine files that exist: the WASM as the package has it, the Node files bundled, both extensions', async () => {
    const files = await hostEngineFiles();
    const pkg = packageHostEngineFiles();
    expect(Buffer.compare(await readFile(files.wasm), await readFile(pkg.wasm))).toBe(0);
    for (const path of [
      files.bindings,
      files.worker,
      files.wasm,
      files.extensions.parquet,
      files.extensions.json,
    ]) {
      await expect(access(path)).resolves.toBeUndefined();
    }
    for (const key of ['bindings', 'worker'] as const) {
      expect(await readFile(files[key], 'utf8')).not.toContain('require("apache-arrow")');
    }
    await files.close();
  });

  it('takes the files of the first dir that has them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otel-html-engine-dir-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    for (const name of names) await writeFile(join(dir, name), 'x');
    const files = await hostEngineFiles({ dirs: [pathToFileURL(`${dir}/`)] });
    expect(files.bindings).toBe(join(dir, n.bindings));
    expect(files.worker).toBe(join(dir, n.worker));
    expect(files.wasm).toBe(join(dir, wasm ?? ''));
    expect(files.extensions).toEqual({ parquet: join(dir, parquet), json: join(dir, json) });
  });

  it('rejects usage naming the bindings file when explicit dirs hold nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otel-html-engine-empty-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const error = await hostEngineFiles({ dirs: [pathToFileURL(`${dir}/`)] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OtelHtmlError);
    expect((error as OtelHtmlError).code).toBe('usage');
    expect((error as OtelHtmlError).message).toContain(n.bindings);
    expect((error as OtelHtmlError).hint).toBe('run the viewer build');
  });

  it('writes the embedded files of a Bun binary into a temp folder that close() removes', async () => {
    const embeddedFiles = names.map((name) => Object.assign(new Blob([`contents of ${name}`]), { name }));
    const files = await hostEngineFiles({ bun: { embeddedFiles } });
    expect(await readFile(files.bindings, 'utf8')).toBe(`contents of ${n.bindings}`);
    expect(files.bindings).toContain('otel-html-host-');
    await files.close();
    await expect(stat(files.bindings)).rejects.toThrow();
  });
});
