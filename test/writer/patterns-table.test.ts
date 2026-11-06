import { describe, expect, test } from 'vitest';
import type { ConfigInput } from '../../src/config/schema.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { Drain, template } from '../../src/rollups/drain.js';
import { severityKey } from '../../src/semconv/severity.js';
import { openSession } from '../../src/writer/session.js';
import { logRecord, logsRequest, span, traceRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';

const OUT = 'r';
const cfg = (extra: NonNullable<ConfigInput['writer']> = {}) =>
  testConfig({ writer: { format: 'site', ...extra } });
const open = (w: TestWriter, mode: 'open' | 'append' | 'replace' = 'replace') =>
  openSession(w.deps, { out: OUT, config: cfg(), mode });

const body = (text: string, severityNumber = 9, extra = {}) =>
  logRecord({ body: { stringValue: text }, severityNumber, ...extra });
const logs = (...records: ReturnType<typeof body>[]) => otlp(logsRequest(records));

function manifest(w: TestWriter): ManifestV4 {
  const text = w.fs.snapshot().get(`${OUT}/data/manifest.js`);
  if (text === undefined) throw new Error('no manifest');
  const m = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(m)) throw new Error('not a v4 manifest');
  return m;
}

async function patterns(w: TestWriter, n: number) {
  const bytes = await w.fs.readBytes(`${OUT}/data/partitions/${String(n).padStart(6, '0')}/patterns.parquet`);
  return decodeTable('patterns', bytes);
}
const cell = (r: object, k: string): unknown => Reflect.get(r, k);

describe('patterns per partition', () => {
  test('two logs with one template make one row with count 2', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(logs(body('user 17 logged in', 9), body('user 42 logged in', 17)), 'a.json');
    await s.flush();
    const rows = await patterns(w, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cluster_id: 0n, count: 2n, template: 'user <*> logged in' });
    expect(JSON.parse(String(cell(rows[0] ?? {}, 'severity_counts')))).toEqual({ '9': 1, '17': 1 });
    expect(cell(rows[0] ?? {}, 'sample')).toBe('user 17 logged in');
    expect(manifest(w).partitions[0]?.files.patterns?.rows).toBe(1);
    await s.close();
  });

  test('a later flush with one more log is a row with count 1 and the same cluster id', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(logs(body('user 17 logged in'), body('disk full on sda')), 'a.json');
    await s.flush();
    await s.add(logs(body('user 99 logged in')), 'b.json');
    await s.flush();
    const second = await patterns(w, 1);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ cluster_id: 0n, count: 1n });
    await s.close();
  });

  test('an append session continues the cluster ids', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(logs(body('user 17 logged in')), 'a.json');
    await s.close();
    const a = await open(w, 'append');
    await a.add(logs(body('disk full on sda'), body('user 5 logged in')), 'b.json');
    await a.flush();
    const rows = await patterns(w, 1);
    expect(rows.map((r) => [cell(r, 'cluster_id'), cell(r, 'count')]).sort()).toEqual([
      [0n, 1n],
      [1n, 1n],
    ]);
    await a.close();
  });

  test('a cut that fails then succeeds yields the same clusters, counted once', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(logs(body('user 17 logged in'), body('user 18 logged in'), body('disk full')), 'a.json');
    w.fs.failNextWrite('000000/patterns.parquet');
    await expect(s.flush()).rejects.toThrow();
    await s.flush();
    const rows = await patterns(w, 0);
    expect(rows.map((r) => [cell(r, 'cluster_id'), cell(r, 'count')]).sort()).toEqual([
      [0n, 2n],
      [1n, 1n],
    ]);
    await s.close();
  });

  test('templates equal what the Drain of the log rollup produces for the same bodies', async () => {
    const bodies = ['GET /a 200 12ms', 'GET /b 404 3ms', 'cache miss for key abc', 'cache miss for key def'];
    const w = createTestWriter();
    const s = await open(w);
    await s.add(logs(...bodies.map((b) => body(b))), 'a.json');
    await s.flush();
    const d = new Drain();
    for (const b of bodies) d.add(b, severityKey(9), 0 as never);
    const expected = d.clusters().map((c) => template(c));
    const got = (await patterns(w, 0)).map((r) => String(cell(r, 'template')));
    expect(got.sort()).toEqual(expected.sort());
    await s.close();
  });
});

describe('patterns and the Drain without logs', () => {
  test('a spans-only flush writes no patterns file', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(logs(body('user 17 logged in')), 'a.json');
    await s.flush();
    await s.add(otlp(traceRequest([span()])), 'b.json');
    await s.flush();
    expect(manifest(w).partitions[1]?.files.patterns).toBeUndefined();
    await s.close();
  });
});
