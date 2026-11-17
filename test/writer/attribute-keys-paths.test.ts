import { describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile, wrapDataFile } from '../../src/format/data-file.js';
import type { PartitionEntry } from '../../src/format/manifest.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { compactPartitions } from '../../src/writer/compaction.js';
import { mergeReports } from '../../src/writer/merge.js';
import { openSession } from '../../src/writer/session.js';
import { keyLogs, keySpans, keysConfig } from '../../test-support/attribute-key-fixture.js';
import { attr, span, traceRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, EPOCH_NS, otlp, testConfig } from '../../test-support/writer-deps.js';
import { manifestOf, spanIdOf, traceIdOf } from './helpers.js';

type W = ReturnType<typeof createTestWriter>;
const config = () => testConfig(keysConfig());

async function write(
  w: W,
  out: string,
  requests: Parameters<typeof otlp>[0][] | ReturnType<typeof keySpans>[],
  flushEach = true,
) {
  const s = await openSession(w.deps, { out, config: config(), mode: 'replace' });
  for (const [i, r] of requests.entries()) {
    await s.add(r as ReturnType<typeof keySpans>, `in:${i}`);
    if (flushEach) await s.flush();
  }
  return s;
}

const recordsOf = (w: W, out: string, table: 'spans' | 'logs'): (Record<string, number> | undefined)[] =>
  manifestOf(w, out).partitions.flatMap((p) =>
    p.files[table] === undefined ? [] : [p.files[table].attributeKeys],
  );

/** The manifest of `out` as a format 6 writer left it: no `attributeKeys`, formatVersion 6. */
async function asFormat6(w: W, out: string): Promise<void> {
  const key = `${out}/data/manifest.js`;
  const raw = reviveDataJson(unwrapDataFile(w.fs.snapshot().get(key) ?? '', MANIFEST_KEY)) as {
    formatVersion: number;
    partitions: { files: Record<string, Record<string, unknown>> }[];
  };
  raw.formatVersion = 6;
  for (const p of raw.partitions)
    for (const f of Object.values(p.files)) Reflect.deleteProperty(f, 'attributeKeys');
  await w.fs.writeTextAtomic(key, wrapDataFile(MANIFEST_KEY, raw));
}

describe('a flush records the attribute keys of its spans and logs', () => {
  test('counts the scalar entries of every kind, by key', async () => {
    const w = createTestWriter();
    const spans = [0, 1, 2].map((i) =>
      span({
        traceId: traceIdOf(i),
        spanId: spanIdOf(i),
        startTimeUnixNano: String(BigInt(EPOCH_NS) + BigInt(i)),
        endTimeUnixNano: String(BigInt(EPOCH_NS) + BigInt(i) + 5n),
        attributes: [
          attr('s', { stringValue: 'a' }),
          attr('mixed', i === 0 ? { stringValue: '1' } : { intValue: String(i) }),
          attr('d', { doubleValue: 1.5 }),
          attr('whole', { doubleValue: 2 }),
          attr('b', { boolValue: i === 1 }),
          attr('blank', { stringValue: '' }),
          attr('nil', {}),
          attr('obj', { kvlistValue: { values: [{ key: 'x', value: { stringValue: 'y' } }] } }),
          attr('arr', { arrayValue: { values: [{ stringValue: 'y' }] } }),
          ...(i === 2 ? [attr('only2', { intValue: '9007199254740993' })] : []),
          ...(i === 1 ? [attr('$odd', { stringValue: 'v' })] : []),
        ],
      }),
    );
    const s = await openSession(w.deps, { out: 'r', config: config(), mode: 'replace' });
    await s.add(otlp(traceRequest(spans)), 'a.json');
    await s.flush();
    expect(recordsOf(w, 'r', 'spans')).toEqual([
      { $odd: 1, b: 3, blank: 3, d: 3, mixed: 3, only2: 1, s: 3, whole: 3 },
    ]);
    expect(recordsOf(w, 'r', 'logs')).toEqual([]);
  });

  test('a logs file records its keys too, and the manifest parses', async () => {
    const w = createTestWriter();
    const s = await write(w, 'r', [keyLogs(0)]);
    await s.close();
    const [rec] = recordsOf(w, 'r', 'logs');
    expect(rec).toMatchObject({ k00: 20, mx: 20 });
    expect(rec).not.toHaveProperty('nil');
    expect(rec).not.toHaveProperty('obj');
  });

  test('a file with more than 1000 distinct keys records nothing, one with exactly 1000 records them all', async () => {
    const w = createTestWriter();
    const at = (n: number) =>
      otlp(
        traceRequest([
          span({
            traceId: traceIdOf(n),
            spanId: spanIdOf(n),
            attributes: Array.from({ length: n }, (_, i) => attr(`key${i}`, { boolValue: true })),
          }),
        ]),
      );
    for (const [out, n] of [
      ['over', 1001],
      ['exact', 1000],
    ] as const) {
      const s = await openSession(w.deps, { out, config: config(), mode: 'replace' });
      await s.add(at(n), 'a.json');
      await s.flush();
    }
    expect(recordsOf(w, 'over', 'spans')).toEqual([undefined]);
    expect(Object.keys(recordsOf(w, 'exact', 'spans')[0] ?? {})).toHaveLength(1000);
  });
});

describe('compaction', () => {
  test('sums the inputs, and equals a fresh flush of the union', async () => {
    const w = createTestWriter();
    const s = await write(w, 'a', [keySpans(0), keyLogs(0), keySpans(1), keyLogs(1)]);
    expect(manifestOf(w, 'a').partitions).toHaveLength(4);
    await s.close();
    const compacted = manifestOf(w, 'a').partitions;
    expect(compacted).toHaveLength(1);
    const u = await openSession(w.deps, { out: 'u', config: config(), mode: 'replace' });
    for (const r of [keySpans(0), keyLogs(0), keySpans(1), keyLogs(1)]) await u.add(r, 'in.json');
    await u.flush();
    for (const table of ['spans', 'logs'] as const) {
      expect(recordsOf(w, 'a', table)).toEqual(recordsOf(w, 'u', table));
      expect(Object.keys(recordsOf(w, 'a', table)[0] ?? {}).length).toBeGreaterThan(6);
    }
  });

  test('an input without the record is counted from its rows: the same result', async () => {
    const w = createTestWriter();
    const s = await write(w, 'a', [keySpans(0), keyLogs(0), keySpans(1), keyLogs(1)]);
    const before = manifestOf(w, 'a').partitions;
    const stripped: PartitionEntry[] = before.map((p, i) => ({
      ...p,
      files: Object.fromEntries(
        Object.entries(p.files).map(([t, f]) => {
          if (i % 2 === 0) return [t, f];
          const { attributeKeys: _dropped, ...rest } = f;
          return [t, rest];
        }),
      ),
    }));
    const m = manifestOf(w, 'a');
    const out = await compactPartitions(w.fs, 'a', stripped, {
      nextPartition: 10,
      rowGroupRows: 100,
      statisticsKeys: m.statisticsKeys as never,
      facetValueCap: 1000,
      source: 'compact:0..3',
    });
    await s.close();
    const reference = manifestOf(w, 'a').partitions.at(-1);
    expect(out.files.spans?.attributeKeys).toEqual(reference?.files.spans?.attributeKeys);
    expect(out.files.logs?.attributeKeys).toEqual(reference?.files.logs?.attributeKeys);
    expect(out.files.spans?.attributeKeys).toBeDefined();
  });
});

describe('a merge', () => {
  const merge = (w: W, from: string, out = 'm') =>
    mergeReports(w.deps, [from], { out, config: config(), mode: 'replace' });

  test('copies the record of a partition as it is', async () => {
    const w = createTestWriter();
    await (await write(w, 'in', [keySpans(0), keyLogs(0)])).close();
    await merge(w, 'in');
    for (const table of ['spans', 'logs'] as const) {
      expect(recordsOf(w, 'm', table)).toEqual(recordsOf(w, 'in', table));
      expect(recordsOf(w, 'm', table)[0]).toBeDefined();
    }
  });

  test('a format 6 source gets the record a flush writes', async () => {
    const w = createTestWriter();
    await (await write(w, 'in', [keySpans(0), keyLogs(1)])).close();
    const flushed = { spans: recordsOf(w, 'in', 'spans'), logs: recordsOf(w, 'in', 'logs') };
    await asFormat6(w, 'in');
    expect(recordsOf(w, 'in', 'spans')).toEqual([undefined]);
    await merge(w, 'in');
    expect(recordsOf(w, 'm', 'spans')).toEqual(flushed.spans);
    expect(recordsOf(w, 'm', 'logs')).toEqual(flushed.logs);
    expect(flushed.spans[0]).toBeDefined();
  });

  test('a copy past the key limit records nothing', async () => {
    const w = createTestWriter();
    const many = otlp(
      traceRequest([
        span({
          traceId: traceIdOf(1),
          spanId: spanIdOf(1),
          attributes: Array.from({ length: 1001 }, (_, i) => attr(`key${i}`, { intValue: '1' })),
        }),
      ]),
    );
    await (await write(w, 'in', [many])).close();
    await asFormat6(w, 'in');
    await merge(w, 'in');
    expect(recordsOf(w, 'm', 'spans')).toEqual([undefined]);
  });
});
