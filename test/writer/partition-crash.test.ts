import { describe, expect, test } from 'vitest';
import type { ConfigInput } from '../../src/config/schema.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isPartitioned, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import type { FileSystem } from '../../src/writer/ports.js';
import { openSession, type WriterSession } from '../../src/writer/session.js';
import { logRecord, logsRequest, metricsRequest, T0 } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { spansRequest } from './helpers.js';

const OUT = 'r';
const cfg = (extra: NonNullable<ConfigInput['writer']> = {}) =>
  testConfig({ writer: { format: 'site', ...extra } });
const open = (w: TestWriter, mode: 'open' | 'append' | 'replace', deps = w.deps) =>
  openSession(deps, { out: OUT, config: cfg(), mode });
const logs = (n: number) => otlp(logsRequest(Array.from({ length: n }, () => logRecord())));
const second = (n: number): string => (BigInt(T0) + BigInt(n) * 1_000_000_000n).toString();
const spans = (n: number, first = 0) => otlp(spansRequest(n, 0, first));

function manifest(w: TestWriter): ManifestV4 {
  const text = w.fs.snapshot().get(`${OUT}/data/manifest.js`);
  if (text === undefined) throw new Error('no manifest');
  const m = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isPartitioned(m)) throw new Error('not v4');
  return m;
}

/** Every file under data/partitions, by relative path. */
function onDisk(w: TestWriter): string[] {
  return [...w.fs.snapshot().keys()]
    .filter((p) => p.startsWith(`${OUT}/data/partitions/`))
    .map((p) => p.slice(`${OUT}/data/partitions/`.length))
    .sort();
}

/** The files the manifest lists, as paths relative to data/partitions. */
function listed(w: TestWriter): string[] {
  return manifest(w)
    .partitions.flatMap((p) => Object.values(p.files).map((f) => f.path.slice('data/partitions/'.length)))
    .sort();
}

/** Every listed file decodes to as many rows as the manifest says. */
async function expectListedDecode(w: TestWriter): Promise<void> {
  for (const p of manifest(w).partitions) {
    for (const [table, f] of Object.entries(p.files)) {
      const bytes = await w.fs.readBytes(`${OUT}/${f.path}`);
      expect(decodeTable(table as 'spans', bytes), f.path).toHaveLength(f.rows);
    }
  }
}

async function flushes(s: WriterSession, count: number, first = 0): Promise<void> {
  for (let i = 0; i < count; i++) {
    await s.add(spans(2, (first + i) * 10), `s${first + i}.json`);
    await s.add(logs(3), `l${first + i}.json`);
    await s.flush();
  }
}

/** A file system whose directory removals fail for paths containing one of `names`: a process that died before them. */
function dyingRemovals(fs: FileSystem, names: string[]): FileSystem {
  return {
    ...fs,
    async removeDir(p) {
      if (names.some((n) => p.includes(n))) throw new Error('died before the removal');
      return fs.removeDir(p);
    },
  };
}

async function appendAndClose(w: TestWriter): Promise<void> {
  const s = await open(w, 'append');
  expect(onDisk(w).filter((p) => !listed(w).includes(p))).toEqual([]); // pruned at open, before any write
  await s.add(spans(1, 900), 'more.json');
  await s.close();
  expect(manifest(w).complete).toBe(true);
  await expectListedDecode(w);
  expect(onDisk(w)).toEqual(listed(w));
}

describe('prune on open', () => {
  test('a listed Parquet file keeps its local-format wrapper while a stray file beside it goes', async () => {
    const w = createTestWriter();
    const s = await open(w, 'replace');
    await s.add(spans(2), 'a.json');
    await s.close();
    await w.fs.writeBytes(`${OUT}/data/partitions/000000/spans.parquet.js`, new Uint8Array([1]));
    await w.fs.writeBytes(`${OUT}/data/partitions/000000/spans.parquet.js.bak`, new Uint8Array([1]));
    await w.fs.writeBytes(`${OUT}/data/partitions/000000/stray.js`, new Uint8Array([1]));
    const a = await open(w, 'append');
    const files = onDisk(w).filter((p) => p.startsWith('000000/'));
    expect(files).toContain('000000/spans.parquet.js');
    expect(files).not.toContain('000000/stray.js');
    expect(files).not.toContain('000000/spans.parquet.js.bak');
    await a.abort();
  });

  test('open on an existing report prunes too, not only append', async () => {
    const w = createTestWriter();
    const s = await open(w, 'replace');
    await flushes(s, 1);
    await s.close();
    await w.fs.writeBytes(`${OUT}/data/partitions/000009/logs.parquet`, new Uint8Array([1]));
    const a = await open(w, 'open');
    expect(onDisk(w).some((p) => p.startsWith('000009/'))).toBe(false);
    await a.abort();
  });

  test('a removal error during prune fails the open, and the lock is released so a second open succeeds', async () => {
    const w = createTestWriter();
    const s = await open(w, 'replace');
    await flushes(s, 1);
    await s.add(spans(2, 50), 'x.json');
    w.fs.failNextWrite('data/manifest.js');
    await expect(s.flush()).rejects.toThrow();
    await s.abort();
    const dying = { ...w.deps, fs: dyingRemovals(w.fs, ['000001']) };
    await expect(open(w, 'append', dying)).rejects.toThrow('died before the removal');
    expect(await w.fs.exists(`${OUT}/data/state/lock.json`)).toBe(false);
    const again = await open(w, 'append');
    expect(onDisk(w).some((p) => p.startsWith('000001/'))).toBe(false);
    await again.abort();
  });

  test('a cut whose manifest write failed leaves an orphan folder; the next append open removes it first', async () => {
    const w = createTestWriter();
    const s = await open(w, 'replace');
    await flushes(s, 1);
    await s.add(spans(2, 50), 'x.json');
    w.fs.failNextWrite('data/manifest.js');
    await expect(s.flush()).rejects.toThrow();
    await s.abort();
    expect(onDisk(w).some((p) => p.startsWith('000001/'))).toBe(true);
    expect(manifest(w).partitions.map((p) => p.n)).toEqual([0]);
    await expectListedDecode(w);
    await appendAndClose(w);
  });

  test('canonical folders only: other names and files under data/partitions are left alone', async () => {
    const w = createTestWriter();
    const s = await open(w, 'replace');
    await flushes(s, 1);
    await s.close();
    for (const p of ['notes/readme.txt', '12/x.parquet', '000007x/y', '0000007/z', 'stray.txt']) {
      await w.fs.writeBytes(`${OUT}/data/partitions/${p}`, new Uint8Array([1]));
    }
    await w.fs.writeBytes(`${OUT}/data/partitions/000007/logs.parquet`, new Uint8Array([1]));
    const a = await open(w, 'append');
    const left = onDisk(w);
    expect(left).toContain('notes/readme.txt');
    expect(left).toContain('12/x.parquet');
    expect(left).toContain('000007x/y');
    expect(left).toContain('0000007/z');
    expect(left).toContain('stray.txt');
    expect(left.some((p) => p.startsWith('000007/'))).toBe(false);
    await a.abort();
  });

  test('unlisted files inside a listed folder go, including a leftover merge file; listed files stay', async () => {
    const w = createTestWriter();
    const s = await open(w, 'replace');
    await s.add(spans(2), 'a.json');
    await s.close();
    const before = onDisk(w);
    await w.fs.writeBytes(`${OUT}/data/partitions/000000/points.parquet`, new Uint8Array([1]));
    await w.fs.writeBytes(`${OUT}/data/partitions/000000/.merge-logs-0-1.parquet`, new Uint8Array([1]));
    const a = await open(w, 'append');
    expect(onDisk(w)).toEqual(before);
    await a.abort();
  });
});

describe('a crash in close()', () => {
  test('after the state write, before the manifest: reopen resumes from the flush partitions', async () => {
    const w = createTestWriter();
    const s = await open(w, 'replace');
    await flushes(s, 3);
    w.fs.failNextWrite('data/manifest.js');
    await expect(s.close()).rejects.toThrow();
    await s.abort();
    // The compacted folder exists, unlisted; the manifest still lists the three flush partitions.
    expect(onDisk(w).some((p) => p.startsWith('000003/'))).toBe(true);
    expect(manifest(w).partitions.map((p) => p.source)).toEqual(['flush:0', 'flush:1', 'flush:2']);
    await expectListedDecode(w);
    const a = await open(w, 'append');
    expect(onDisk(w).some((p) => p.startsWith('000003/'))).toBe(false);
    await a.abort();
    await appendAndClose(w);
    expect(manifest(w).partitions.map((p) => p.source)[0]).toMatch(/^compact:/);
  });

  test('after the manifest, before the delete: the stale flush folders are pruned on the next open', async () => {
    const w = createTestWriter();
    const dying = { ...w.deps, fs: dyingRemovals(w.fs, ['000000', '000001', '000002']) };
    const s = await open(w, 'replace', dying);
    await flushes(s, 3);
    await s.close(); // the manifest is committed; the removals failed and were logged
    expect(manifest(w).partitions.map((p) => [p.n, p.source])).toEqual([[3, 'compact:0..2']]);
    expect(onDisk(w).some((p) => p.startsWith('000000/'))).toBe(true);
    await expectListedDecode(w);
    await appendAndClose(w);
  });

  test('an in-process failure while writing the compacted file: the flush partitions stay listed and the half-written folder is pruned', async () => {
    const w = createTestWriter();
    const dying = { ...w.deps, fs: dyingRemovals(w.fs, ['000003']) };
    const s = await open(w, 'replace', dying);
    await flushes(s, 3);
    w.fs.failNextWrite('000003/logs.parquet');
    await s.close(); // compaction failed and was logged; its cleanup died too
    expect(manifest(w).partitions.map((p) => p.source)).toEqual(['flush:0', 'flush:1', 'flush:2']);
    expect(onDisk(w).some((p) => p.startsWith('000003/'))).toBe(true); // spans.parquet written before logs failed
    await expectListedDecode(w);
    await appendAndClose(w);
  });
});

describe('a flush that fails between two tables', () => {
  const counter = (value: number, t: number) =>
    otlp(
      metricsRequest([
        {
          name: 'c',
          unit: 'By',
          sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: [{ asInt: String(value), startTimeUnixNano: T0, timeUnixNano: second(t) }],
          },
        } as never,
      ]),
    );

  test('after logs were written, the manifest lists the old partition only and a retry writes both tables whole', async () => {
    const w = createTestWriter();
    const s = await open(w, 'replace');
    await s.add(counter(10, 1), 'm0.json');
    await s.flush(); // partition 0: the first point, no delta
    const before = listed(w);
    await s.add(logs(2), 'l1.json');
    await s.add(counter(15, 2), 'm1.json');
    w.fs.failNextWrite('000001/points.parquet');
    await expect(s.flush()).rejects.toThrow('injected write failure');
    expect(manifest(w).partitions.map((p) => p.n)).toEqual([0]);
    expect(listed(w)).toEqual(before);
    expect(onDisk(w)).toContain('000001/logs.parquet'); // written before points failed
    expect(onDisk(w)).not.toContain('000001/points.parquet');
    expect(listed(w)).not.toContain('000001/logs.parquet');
    await expectListedDecode(w);

    await s.flush(); // the rows went back (R22): the retry writes partition 1 with both tables
    const p1 = manifest(w).partitions.find((p) => p.n === 1);
    expect(Object.keys(p1?.files ?? {}).sort()).toEqual(['logs', 'patterns', 'points']); // patterns derive from the logs
    expect(p1?.files.logs?.rows).toBe(2);
    expect(p1?.files.points?.rows).toBe(1);
    const points = decodeTable(
      'points',
      await w.fs.readBytes(`${OUT}/data/partitions/000001/points.parquet`),
    );
    // The stream state advanced once: the second point's delta is 15 - 10, not null or 0.
    expect(points.map((r) => Reflect.get(r, 'delta_value'))).toEqual([5]);
    await expectListedDecode(w);
    await s.abort();
    await appendAndClose(w); // the reopened report prunes nothing it lists
  });
});
