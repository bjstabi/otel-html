import { restConnector } from '@uwdata/mosaic-core';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { afterEach, expect, test } from 'vitest';
import type { HostEngine } from '../../src/host/engine.ts';
import type { HostManifest } from '../../src/host/manifest.ts';
import { hostHandler, QUERY_PATH } from '../../src/host/server.ts';
import { listenHttp } from '../../src/receiver/http.ts';
import { createCoordinator } from '../../src/viewer/data/mosaic.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

// The mosaic-core types need DOM libs, so this check lives with the viewer-data project; the engine is a stub.
test('mosaic restConnector and a Coordinator read the host over HTTP', async () => {
  const seen: string[] = [];
  const engine: HostEngine = {
    restarts: 0,
    async query(sql) {
      seen.push(sql);
      return tableToIPC(tableFromArrays({ n: [5n] }), 'stream');
    },
    async close() {},
  };
  const handler = hostHandler(
    {
      report: 'r',
      manifest: { script: '', partitionBytes: 0 } as unknown as HostManifest,
      engine,
      viewerAssets: { files: async () => [], entry: () => ({ script: 'assets/v.js', style: null }) },
      logger,
      tracer: { startSpan: () => ({ setAttributes() {}, recordError() {}, end() {} }) },
    },
    new Map(),
    '',
  );
  const listener = await listenHttp(handler, '127.0.0.1', 0, '--port');
  closers.push(() => listener.close());
  const coordinator = createCoordinator(
    restConnector({ uri: listener.address + QUERY_PATH, method: 'POST' }),
    logger,
  );
  const table = await coordinator.query('SELECT count(*) AS n FROM spans', { cache: false });
  expect(table.getChild('n')?.at(0)).toBe(5n);
  expect(seen).toEqual(['SELECT count(*) AS n FROM spans']);
});
