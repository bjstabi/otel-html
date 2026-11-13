import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHostManifest } from '../../src/host/manifest.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { buildFormat4Report, spansOnlyRequest } from '../../test-support/format4-fixture.js';
import { writeReportDir } from '../../test-support/report-dir.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'otel-html-host-manifest-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  if (!(e instanceof OtelHtmlError)) throw new Error('expected an OtelHtmlError');
  return e;
}

describe('readHostManifest', () => {
  it('reads a format-4 report: the manifest, its script text and the partition bytes', async () => {
    const fixture = await buildFormat4Report([spansOnlyRequest(3), spansOnlyRequest(2)], { close: false });
    const report = await writeReportDir(fixture);
    cleanups.push(report.close);
    const read = await readHostManifest(createNodeFileSystem(), report.dir);
    expect(read.manifest.formatVersion).toBe(5);
    expect(read.script.startsWith('__OH__.push("manifest",')).toBe(true);
    const sum = read.manifest.partitions
      .flatMap((p) => Object.values(p.files))
      .reduce((n, f) => n + f.bytes, 0);
    expect(sum).toBeGreaterThan(0);
    expect(read.partitionBytes).toBe(sum);
  });

  it('a folder without data/manifest.js is a usage error naming it', async () => {
    const dir = await tempDir();
    const e = await failure(readHostManifest(createNodeFileSystem(), dir));
    expect(e.code).toBe('usage');
    expect(e.message).toContain(`no report found at ${dir} (missing data/manifest.js)`);
  });

  it('a format-3 report is invalid-report with the merge hint', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'data'));
    await copyFile('fixtures/reports/format-3/data/manifest.js', join(dir, 'data/manifest.js'));
    const e = await failure(readHostManifest(createNodeFileSystem(), dir));
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain('format 3');
    expect(e.hint).toContain('otel-html merge');
  });
});
