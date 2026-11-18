import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { mergeWith } from '../../src/api/convert.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isPartitioned, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { createTestWriter, type TestWriter } from '../../test-support/writer-deps.js';
import { manifestOf } from '../writer/helpers.js';

const REPORTS = join(import.meta.dirname, '../../fixtures/reports');

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1));
}

/** Copies `fixtures/reports/<name>/data/**` from disk into the writer's file system at `<name>/data/`; returns its manifest. */
async function copyFixtureReport(w: TestWriter, name: string) {
  const root = join(REPORTS, name, 'data');
  for (const rel of filesUnder(root)) {
    await w.deps.fs.writeBytes(`${name}/data/${rel}`, readFileSync(join(root, rel)));
  }
  const text = w.fs.snapshot().get(`${name}/data/manifest.js`);
  if (text === undefined) throw new Error('no manifest');
  return parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
}

describe.each([
  ['format-1', 1],
  ['format-2', 2],
  ['format-3', 3],
  ['format-5', 5],
  ['format-6', 6],
  ['format-7', 7],
  ['format-8', 8],
])('%s', (name, version) => {
  test('merge reads it and the totals survive', async () => {
    const w = createTestWriter();
    const expected = await copyFixtureReport(w, name);
    // The fixture is frozen at its version; frozen-checksums.test.ts pins its bytes.
    expect(expected.formatVersion).toBe(version);
    const summary = await mergeWith({ inputs: [name], out: 'm' }, w.deps);
    expect(summary.totals).toEqual(expected.totals);
    expect(summary.totals.spans).toBeGreaterThan(0);
    expect(summary.totals.metrics).toBeGreaterThan(0);
    // Every merge writes format 8: a chunk report is replayed through a flush, a format-5 report's partitions are copied as they are.
    expect(manifestOf(w, 'm').formatVersion).toBe(8);
  });
  test('merge into a format-6 (site) report keeps the totals', async () => {
    const w = createTestWriter();
    const expected = await copyFixtureReport(w, name);
    const config = { writer: { format: 'site' as const } };
    const summary = await mergeWith({ inputs: [name], out: 'm4', config }, w.deps);
    expect(summary.totals).toEqual(expected.totals);
    expect(w.fs.snapshot().get('m4/data/manifest.js')).toContain('"formatVersion":8');
  });
});

describe('format-8', () => {
  test('holds a cicd file with run, job and tasks rows', () => {
    const root = join(REPORTS, 'format-8/data');
    const text = readFileSync(join(root, 'manifest.js'), 'utf8');
    const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
    if (!isPartitioned(manifest)) throw new Error('not a partition manifest');
    const kinds = new Set<unknown>();
    for (const p of manifest.partitions) {
      expect(p.cicd).toBe(true);
      const file = p.files.cicd;
      if (file === undefined) continue;
      for (const row of decodeTable('cicd', readFileSync(join(root, '..', file.path))))
        kinds.add((row as { kind: unknown }).kind);
    }
    expect(kinds).toEqual(new Set(['run', 'job', 'tasks']));
  });
});
