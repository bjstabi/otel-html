import { afterAll, beforeAll } from 'vitest';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import { buildFormat4Report, openFixtureDb } from '../../test-support/format4-fixture.js';
import { attr, gauge, metricsRequest, pointsAt, summary } from '../../test-support/otlp-builders.js';
import { otlp } from '../../test-support/writer-deps.js';

const g = globalThis as { XMLHttpRequest?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
g.IS_REACT_ACT_ENVIRONMENT = true;
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const str = (v: string) => ({ stringValue: v });
const q = (quantile: number, value: number) => ({ quantile, value });

const withUnit = (m: ReturnType<typeof gauge>, unit: string) => ({ ...m, unit });

const REQUEST = otlp(
  metricsRequest(
    [
      withUnit(
        gauge('queue.depth', [
          ...pointsAt([0, 1000, 2000], (i) => ({ asDouble: 1 + i }), [
            attr('host', str('h1')),
            attr('k', str('abc')),
          ]),
          ...pointsAt([0, 1000, 2000], (i) => ({ asDouble: 5 + i }), [
            attr('host', str('h2')),
            attr('k', str('a')),
          ]),
        ]),
        'ms',
      ),
      summary(
        'rpc.latency',
        pointsAt([0, 1000], () => ({ count: '2', sum: 3, quantileValues: [q(0.5, 1), q(0.99, 9)] })),
      ),
    ],
    [attr('service.name', str('svc-a'))],
  ) as never,
);

/** A format-4 report with a two-series gauge and a summary, behind a data source over the Node engine. */
export function metricsSource(): () => DataSource {
  let db: TestDb | null = null;
  let source: DataSource | null = null;
  let xhr: unknown;
  beforeAll(async () => {
    // DuckDB's Node runtime reads registered buffers through XMLHttpRequest when one exists (jsdom's), and that path
    // fails ("null function"); hiding it for the file's duration selects the Node file path.
    xhr = g.XMLHttpRequest;
    g.XMLHttpRequest = undefined;
    const f = await buildFormat4Report([REQUEST], { close: false });
    db = await openFixtureDb(f);
    source = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
      manifest: f.manifest,
    });
  });
  afterAll(() => {
    try {
      db?.close();
    } finally {
      g.XMLHttpRequest = xhr;
    }
  });
  return () => {
    if (source === null) throw new Error('the metrics source is not open');
    return source;
  };
}
