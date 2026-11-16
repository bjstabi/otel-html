import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../test-support/format4-fixture.js';
import { attr, logRecord, logsRequest, span, traceRequest } from '../../test-support/otlp-builders.js';
import { EPOCH_NS, otlp } from '../../test-support/writer-deps.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const BASE = BigInt(EPOCH_NS);
// 2^53 ns past the anchor: about 104 days, a valid time that is not a safe integer count
const FAR = 9007199254740992n;
const res = [attr('service.name', { stringValue: 'svc' })];

let f: Format4Fixture;
let db: TestDb;
let source: DataSource;

beforeAll(async () => {
  const spans = [0n, 1000n].map((d, i) =>
    span({
      traceId: String(i + 1).padStart(32, '0'),
      spanId: String(i + 1).padStart(16, '0'),
      name: `op-${i}`,
      startTimeUnixNano: String(BASE + d),
      endTimeUnixNano: String(BASE + d + 1000n),
    }),
  );
  const logs = [0n, 1000n].map((d) =>
    logRecord({ timeUnixNano: String(BASE + d), body: { stringValue: 'x' } }),
  );
  f = await buildFormat4Report(
    [otlp(traceRequest(spans, res) as never), otlp(logsRequest(logs, res) as never)],
    { close: false },
  );
  db = await openFixtureDb(f);
  // a merged report's anchor can lie far before its data: the first record is FAR ns after it
  const manifest = { ...f.manifest, epochUnixNano: String(BASE - FAR) };
  source = createDuckDbDataSource({
    engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
    manifest,
  });
});
afterAll(async () => {
  await source.close();
});

const signal = new AbortController().signal;

describe('points beyond 2^53 ns from the anchor', () => {
  test('span points keep the far span, rounded like a row time', async () => {
    const got = await source.spanPoints(
      {
        condition: null,
        text: '',
        window: null,
        mode: 'spans',
        sort: { column: 'start', dir: 'desc' },
        limit: 10,
      },
      signal,
    );
    expect(got.map((p) => p.start)).toEqual([Number(FAR + 1000n), Number(FAR)]);
  });

  test('log points keep the far log', async () => {
    const got = await source.logPoints(
      { condition: null, text: '', window: null, sort: { column: 'time', dir: 'desc' }, limit: 10 },
      signal,
    );
    expect(got.map((p) => p.time)).toEqual([Number(FAR + 1000n), Number(FAR)]);
  });
});
