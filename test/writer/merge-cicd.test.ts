import '../../src/writer/parquet-wasm-source.js';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isPartitioned, parseAnyManifest } from '../../src/format/manifest.js';
import { batchFromRows } from '../../src/format/parquet/batch.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { encodeCicd } from '../../src/writer/cicd-encode.js';
import { CicdRowSet } from '../../src/writer/cicd-rows.js';
import { mergeReports } from '../../src/writer/merge.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { openSession } from '../../src/writer/session.js';
import { createTestWriter, testConfig } from '../../test-support/writer-deps.js';
import { ciRequest } from './widget-index-helpers.js';

const reads = vi.hoisted(() => ({ tables: [] as string[] }));
vi.mock('../../src/format/parquet/stream.js', async (orig) => {
  const mod = await orig<typeof import('../../src/format/parquet/stream.js')>();
  return {
    ...mod,
    readColumns: (...args: Parameters<typeof mod.readColumns>) => {
      reads.tables.push(args[0]);
      return mod.readColumns(...args);
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merge-cicd-'));
  reads.tables.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FROZEN = join(import.meta.dirname, '../../fixtures/reports');
const config = testConfig({ writer: { format: 'site' as const } });

function manifestAt(name: string) {
  const text = readFileSync(join(dir, name, 'data/manifest.js'), 'utf8');
  const m = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isPartitioned(m)) throw new Error('not partitioned');
  return m;
}
const bytesOf = (name: string, path: string) => new Uint8Array(readFileSync(join(dir, name, path)));
const merge = (inputs: string[], out = 'm') =>
  mergeReports(
    { ...createTestWriter().deps, fs: createNodeFileSystem() },
    inputs.map((i) => join(dir, i)),
    {
      out: join(dir, out),
      config,
      mode: 'replace',
    },
  );

/** The `cicd` rows a fresh derivation gives for a partition's spans. */
function derived(name: string, p: ReturnType<typeof manifestAt>['partitions'][number]) {
  const spans = p.files.spans;
  if (spans === undefined) return [];
  const set = new CicdRowSet();
  set.add(batchFromRows('spans', decodeTable('spans', bytesOf(name, spans.path))));
  return set.rows();
}

describe('a merge copy writes the cicd table', () => {
  for (const fmt of ['format-6', 'format-7']) {
    test(`a ${fmt} input gets a cicd file per partition holding CI spans, equal to a fresh write`, async () => {
      cpSync(join(FROZEN, fmt), join(dir, 'in'), { recursive: true });
      await merge(['in']);
      const m = manifestAt('m');
      let withRows = 0;
      for (const p of m.partitions) {
        expect(p.cicd).toBe(true);
        const want = derived('m', p);
        if (want.length === 0) {
          expect(p.files.cicd).toBeUndefined();
          continue;
        }
        withRows++;
        expect(decodeTable('cicd', bytesOf('m', p.files.cicd?.path ?? ''))).toEqual(
          decodeTable('cicd', encodeCicd(want, 1000)),
        );
      }
      if (fmt === 'format-7') expect(withRows).toBeGreaterThan(0);
    });
  }

  test('a flagged input is copied byte for byte and the spans file is read once per partition', async () => {
    const w = { ...createTestWriter().deps, fs: createNodeFileSystem() };
    const s = await openSession(w, { out: join(dir, 'in'), config, mode: 'replace' });
    await s.add(ciRequest([{ i: 1 }, { i: 2, job: 'success', task: 'build' }]), 'a.json');
    await s.close();
    const from = manifestAt('in').partitions[0]?.files.cicd;
    expect(from).toBeDefined();
    reads.tables.length = 0;
    await merge(['in']);
    const p = manifestAt('m').partitions[0];
    expect(p?.cicd).toBe(true);
    expect(Array.from(bytesOf('m', p?.files.cicd?.path ?? ''))).toEqual(
      Array.from(bytesOf('in', from?.path ?? '')),
    );
    expect(reads.tables.filter((t) => t === 'cicd')).toEqual([]);
  });

  test('an unflagged input is computed with one read of each spans file', async () => {
    cpSync(join(FROZEN, 'format-7'), join(dir, 'in'), { recursive: true });
    const partitions = manifestAt('in').partitions.filter((p) => p.files.spans !== undefined).length;
    reads.tables.length = 0;
    await merge(['in']);
    expect(reads.tables.filter((t) => t === 'spans')).toHaveLength(partitions);
  });
});
