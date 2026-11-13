import { tableFromIPC } from 'apache-arrow';
import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { CATALOGUE, type CatalogueContext, type ScalingIds } from '../../src/viewer/data/catalogue.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../test-support/format4-fixture.js';
import { attr, logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import { otlp } from '../../test-support/writer-deps.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function open(f: Format4Fixture) {
  const db = await openFixtureDb(f);
  const engine = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
  const ds = createDuckDbDataSource({ engine, manifest: f.manifest });
  const count = async (table: string): Promise<number> => {
    const bytes = await db.connector.query({ type: 'arrow', sql: `SELECT count(*) AS n FROM ${table}` });
    const [row] = tableFromIPC(bytes).toArray() as { n: bigint | number }[];
    return Number(row?.n);
  };
  return {
    make: () => createDuckDbDataSource({ engine, manifest: f.manifest }),
    count,
    close: async () => {
      await ds.close();
      db.close();
    },
  };
}

const logsOnly = (): Promise<Format4Fixture> =>
  buildFormat4Report([
    otlp(
      logsRequest(
        [logRecord({ body: { stringValue: 'one' } }), logRecord({ body: { stringValue: 'two' } })],
        [attr('service.name', { stringValue: 'svc-a' })],
      ) as never,
    ),
  ]);

/** Values no row of an empty report holds: every catalogue entry must still answer. */
const IDS: ScalingIds = {
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  logRef: '0.0',
  service: 'none',
  resource: 'none',
  runId: 'none',
  route: '/none',
  text: 'none',
  metric: 'none',
};
const BY_ID = [
  'trace.get',
  'trace.share',
  'trace.has',
  'trace.logs',
  'log.get',
  'log.surrounding',
  'metrics.showOptions',
  'metrics.query.short',
  'metrics.query.long',
  'metrics.query.summary',
  'metrics.query.residual.long',
  'metrics.runQuery',
  'metrics.runQuery.failed',
];
const LONG_WINDOW = { start: 0, end: 10 ** 15 };

describe('format 5 with a table missing', () => {
  test('a logs-only format-5 report opens: span_rollups is an empty typed view, log_rollups has rows', async () => {
    const f = await logsOnly();
    expect(f.manifest.formatVersion).toBe(5);
    const [partition] = f.manifest.partitions;
    expect(partition?.files.span_rollups).toBeUndefined();
    expect(partition?.files.log_rollups).toBeDefined();
    const r = await open(f);
    try {
      expect(await r.count('span_rollups')).toBe(0);
      expect(await r.count('log_rollups')).toBeGreaterThan(0);
      expect(await r.count('spans')).toBe(0);
      expect(await r.count('logs')).toBe(2);
      // an empty span_rollups still has its columns: a query naming them is a result, not a binder error
      expect(await r.count('span_rollups WHERE service_name IS NOT NULL')).toBe(0);
    } finally {
      await r.close();
    }
  });

  test('an empty format-5 report opens and every catalogue entry answers without an error', async () => {
    const f = await buildFormat4Report([]);
    expect(f.manifest.formatVersion).toBe(5);
    expect(f.files.size).toBe(0);
    const r = await open(f);
    try {
      expect(await r.count('span_rollups')).toBe(0);
      expect(await r.count('log_rollups')).toBe(0);
      const failures: string[] = [];
      for (const entry of CATALOGUE) {
        const ctx: CatalogueContext = { window: entry.window ? LONG_WINDOW : null, ids: IDS };
        // a fresh data source per entry: the metric catalog and the trace are memoised per source
        const ds = r.make();
        try {
          await entry.run(ds, ctx);
        } catch (e) {
          if (!(e instanceof OtelHtmlError)) throw e;
          failures.push(`${entry.id}: ${e.message}`);
        }
      }
      // only a lookup of one thing by id may fail, and with the typed not-found error: nothing else may reach a missing table
      expect(failures.map((f) => f.split(':')[0])).toEqual(BY_ID);
    } finally {
      await r.close();
    }
  });
});
