import '../../src/writer/parquet-wasm-source.js';
import { describe, expect, test } from 'vitest';
import { batchFromRows } from '../../src/format/parquet/batch.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { CicdRowSet, encodeCicd } from '../../src/writer/cicd-rows.js';
import { openSession } from '../../src/writer/session.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';
import { allSpans, manifestOf, spansRequest, tableRowsOf } from './helpers.js';
import { ciRequest } from './widget-index-helpers.js';

const get = (r: Record<string, unknown>, k: string): unknown => r[k];

const RUN = [
  { i: 1 },
  { i: 2, job: 'success' as const, task: 'build' },
  { i: 3, job: 'skip' as const, task: 'test' },
];

/** The rows Task 5's derivation gives for the spans a report holds. */
function oracle(w: ReturnType<typeof createTestWriter>, out: string) {
  const set = new CicdRowSet();
  set.add(batchFromRows('spans', allSpans(w, out)));
  return decodeTable('cicd', encodeCicd(set.rows(), 1000));
}

describe('a flush writes the cicd table', () => {
  test('a CI run: the file, its rows and the partition flag', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config: testConfig(), mode: 'replace' });
    await s.add(ciRequest(RUN), 'a.json');
    await s.flush();
    await s.close();
    const entry = manifestOf(w, 'r').partitions[0];
    expect(entry?.cicd).toBe(true);
    expect(entry?.files.cicd?.rows).toBeGreaterThan(0);
    const rows = tableRowsOf(w, 'r', 'cicd');
    expect(rows).toEqual(oracle(w, 'r'));
    expect(rows.map((r) => get(r, 'kind'))).toContain('run');
  });

  test('spans that are not CI: no file, but the flag', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config: testConfig(), mode: 'replace' });
    await s.add(otlp(spansRequest(3)), 'a.json');
    await s.close();
    const entry = manifestOf(w, 'r').partitions[0];
    expect(entry?.cicd).toBe(true);
    expect(entry?.files.cicd).toBeUndefined();
  });

  test('three flushes compacted give one cicd file holding the union', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config: testConfig(), mode: 'replace' });
    for (const run of ['7', '8', '9']) {
      await s.add(ciRequest(RUN.map((x) => ({ ...x, run, trace: Number(run) }))), `${run}.json`);
      await s.flush();
    }
    expect(manifestOf(w, 'r').partitions).toHaveLength(3);
    await s.close();
    const m = manifestOf(w, 'r');
    expect(m.partitions).toHaveLength(1);
    expect(m.partitions[0]?.cicd).toBe(true);
    const rows = tableRowsOf(w, 'r', 'cicd');
    expect(rows).toEqual(oracle(w, 'r'));
    expect(new Set(rows.map((r) => get(r, 'trace_id'))).size).toBe(3);
  });
});
