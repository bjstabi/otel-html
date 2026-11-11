import { literal, Query, sql } from '@uwdata/mosaic-sql';
import { afterEach, describe, expect, test } from 'vitest';
import { buildFormat4Report, openFixtureDb, spansOnlyRequest } from '../../test-support/format4-fixture.js';
import { writeReportDir } from '../../test-support/report-dir.js';
import { costOf, REQUESTS_PER_OPEN, REQUESTS_PER_READ, rangesOf } from '../../test-support/scaling/cost.js';
import {
  type CountingEngine,
  openCountingEngine,
  type ReadEvent,
} from '../../test-support/scaling/counting-engine.js';

const open = (path: string): ReadEvent => ({ path, kind: 'open', offset: 0, bytes: 0 });
const read = (path: string, offset: number, bytes: number): ReadEvent => ({
  path,
  kind: 'read',
  offset,
  bytes,
});

describe('the counting Node engine', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });

  async function twoPartitions(): Promise<{ c: CountingEngine; first: string; second: string }> {
    const report = await buildFormat4Report([spansOnlyRequest(40), spansOnlyRequest(40)], { close: false });
    const dir = await writeReportDir(report);
    closers.push(dir.close);
    const c = await openCountingEngine(dir.dir, report.manifest);
    closers.push(c.close);
    const [first, second] = report.manifest.partitions.map((p) => p.files.spans?.path);
    if (first === undefined || second === undefined) throw new Error('two partitions with spans expected');
    return { c, first, second };
  }

  test('a count over one file reads that file and no other', async () => {
    const { c, second } = await twoPartitions();
    await c.cold();
    await c.take();
    await c.engine.query(
      Query.from('spans')
        .select({ n: sql`count(*)` })
        .where(sql`filename = ${literal(second)} AND name = 'op-1'`),
    );
    const paths = new Set((await c.take()).map((e) => e.path));
    expect([...paths]).toEqual([second]);
  });

  test('cold() makes a repeated statement cost the same again', async () => {
    const { c } = await twoPartitions();
    const run = async (): Promise<ReadEvent[]> => {
      await c.engine.query(Query.from('spans').select({ n: sql`count(*)` }));
      return await c.take();
    };
    await c.cold();
    await c.take();
    const a = costOf(await run(), new Map());
    await c.cold();
    const b = costOf(await run(), new Map());
    expect(b).toEqual(a);
    expect(a.serial).toBeGreaterThan(0);
  });

  test('take() without cold() after a repeat shows the cache', async () => {
    const { c } = await twoPartitions();
    await c.cold();
    await c.take();
    const run = async (): Promise<ReadEvent[]> => {
      await c.engine.query(Query.from('spans').select({ n: sql`count(*)` }).where(sql`name = 'op-1'`));
      return await c.take();
    };
    const first = costOf(await run(), new Map());
    c.engine.clearCache();
    const second = costOf(await run(), new Map());
    expect(second.serial).toBeLessThan(first.serial);
  });

  describe('the read-ahead model', () => {
    const p = 'data/partitions/000001/spans.parquet';
    const K = 16_384;
    const blocks = (...at: number[]): ReadEvent[] => at.map((o) => read(p, o, K));

    test('sequential reads merge into growing ranges', () => {
      // 0: 16 KiB range; 16 KiB: 64 KiB range (to 80 KiB); the reads up to 80 KiB are inside it
      expect(rangesOf(blocks(0, K, 2 * K, 3 * K, 4 * K))).toBe(2);
      // 80 KiB: 256 KiB range (to 336 KiB); 336 KiB: 1 MiB range; 1360 KiB: 4 MiB; then the size stays
      const starts = [0, 16, 80, 336, 1360, 5456].map((kib) => kib * 1024);
      expect(rangesOf(blocks(...starts))).toBe(6);
      expect(rangesOf(blocks(...starts, 5456 * 1024 + 4 * 1024 * 1024))).toBe(7);
      expect(rangesOf(blocks(...starts, 5456 * 1024 + 4 * 1024 * 1024 - K))).toBe(6);
    });

    test('a jump starts a new 16 KiB range, and the stream it left continues later', () => {
      expect(rangesOf(blocks(0, 1_000_000))).toBe(2);
      // 0, K (64 KiB to 80 KiB), a jump, then 80 KiB continues the first stream and fetches 256 KiB
      expect(rangesOf(blocks(0, K, 1_000_000, 5 * K))).toBe(4);
      // the 256 KiB range it fetched holds the reads that follow
      expect(rangesOf(blocks(0, K, 1_000_000, 5 * K, 100 * 1024 + 2 * K))).toBe(4);
    });

    test('a read larger than the range size fetches the read, an open forgets the streams', () => {
      expect(rangesOf([read(p, 0, 100_000), read(p, 50_000, 40_000)])).toBe(1);
      expect(rangesOf([...blocks(0), open(p), ...blocks(0)])).toBe(2);
    });

    test('costOf prices the ranges, not the read calls', () => {
      expect(costOf([open(p), ...blocks(0, K, 2 * K, 3 * K)], new Map())).toEqual({
        serial: REQUESTS_PER_OPEN + 2 * REQUESTS_PER_READ,
        parallel: 0,
        bytes: 4 * K,
      });
    });
  });

  test('a path in `prepared` costs one parallel request of its size', () => {
    const p = 'partitions/000001/spans.parquet';
    expect(costOf([open(p), read(p, 0, 8), read(p, 100, 50)], new Map([[p, 4096]]))).toEqual({
      serial: 0,
      parallel: 1,
      bytes: 4096,
    });
  });
});

describe('WriterDeps.rowGroupRows', () => {
  test('overrides the configured size', async () => {
    const report = await buildFormat4Report([spansOnlyRequest(2000)], { rowGroupRows: 512 });
    const db = await openFixtureDb(report);
    const spans = report.manifest.partitions[0]?.files.spans?.path;
    try {
      const [row] = db.rows(
        `SELECT count(DISTINCT row_group_id) AS groups FROM parquet_metadata('${spans}')`,
      );
      const { groups } = row ?? {};
      expect(Number(groups)).toBe(4);
    } finally {
      db.close();
    }
  });
});
