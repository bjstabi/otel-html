import { describe, expect, it } from 'vitest';
import { openTestDb, testDbPoolStats } from '../../test-support/duckdb-node.js';
import { buildFormat4Report, openFixtureDb, spansOnlyRequest } from '../../test-support/format4-fixture.js';

// OTEL_HTML_DUCKDB_POOL=0 turns the pool off, so the reuse count this test asserts cannot move
const { OTEL_HTML_DUCKDB_POOL: POOL_ENV } = process.env;

describe('the pooled test database', () => {
  it.skipIf(POOL_ENV === '0')(
    '(pool on) a second open that registers other bytes under the same name reads the new bytes',
    async () => {
      const three = await buildFormat4Report([spansOnlyRequest(3)]);
      const five = await buildFormat4Report([spansOnlyRequest(5)]);
      const a = await openFixtureDb(three);
      expect(a.rows('SELECT count(*)::INT AS n FROM spans')).toEqual([{ n: 3 }]);
      a.close();
      const before = testDbPoolStats().reused;
      const b = await openFixtureDb(five); // same paths, other bytes: service-share-parity's case
      expect(testDbPoolStats().reused).toBe(before + 1); // the same instance, so the test proves the pool
      expect(b.rows('SELECT count(*)::INT AS n FROM spans')).toEqual([{ n: 5 }]);
      const [path] = [...five.files.keys()].filter((p) => p.endsWith('spans.parquet'));
      expect(b.rows(`SELECT num_rows::INT AS n FROM parquet_file_metadata('${path}')`)).toEqual([{ n: 5 }]);
      b.close();
    },
  );

  it('nothing an open created survives its close', async () => {
    const a = await openTestDb();
    a.exec('CREATE TABLE t AS SELECT 1 AS x');
    a.exec('CREATE MACRO m(v) AS v + 1');
    a.exec("SET TimeZone = 'Asia/Tokyo'");
    a.close();
    const b = await openTestDb();
    expect(b.rows("SELECT count(*)::INT AS n FROM duckdb_tables() WHERE table_name = 't'")).toEqual([
      { n: 0 },
    ]);
    expect(b.rows("SELECT count(*)::INT AS n FROM duckdb_functions() WHERE function_name = 'm'")).toEqual([
      { n: 0 },
    ]);
    expect(b.rows("SELECT current_setting('TimeZone') AS tz")).not.toEqual([{ tz: 'Asia/Tokyo' }]);
    b.close();
  });

  it('filename reads back as the registered name through rows()', async () => {
    const f = await buildFormat4Report([spansOnlyRequest(2)]);
    const db = await openFixtureDb(f);
    const [{ filename }] = db.rows('SELECT filename FROM spans LIMIT 1') as [{ filename: string }];
    expect(f.files.has(filename)).toBe(true);
    db.close();
  });

  it('an unpooled open is a fresh instance', async () => {
    const before = testDbPoolStats();
    const db = await openTestDb({ pooled: false });
    expect(testDbPoolStats()).toEqual({ created: before.created + 1, reused: before.reused });
    db.close();
    const again = await openTestDb({ pooled: false });
    expect(testDbPoolStats().reused).toBe(before.reused);
    again.close();
  });
});
