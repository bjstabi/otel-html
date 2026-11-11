import { literal, Query, sql } from '@uwdata/mosaic-sql';
import { afterEach, describe, expect, test } from 'vitest';
import { buildFormat4Report, openFixtureDb, spansOnlyRequest } from '../../test-support/format4-fixture.js';
import { writeReportDir } from '../../test-support/report-dir.js';
import { costOf } from '../../test-support/scaling/cost.js';
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
