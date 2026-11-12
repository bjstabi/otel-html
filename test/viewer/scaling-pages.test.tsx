import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { CATALOGUE } from '../../src/viewer/data/catalogue.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { costOf } from '../../test-support/scaling/cost.js';
import { openCountingEngine, type ReadEvent } from '../../test-support/scaling/counting-engine.js';
import {
  BASE,
  buildScalingReport,
  PAGE_CROSS,
  pageShapes,
  type ScalingReport,
  type Shape,
} from '../../test-support/scaling/generator.js';
import { closeMeasured } from '../../test-support/scaling/measure.js';
import { entryIdsOf, recordingDataSource } from '../../test-support/scaling/recording-source.js';
import { manifestWithCi, measureShape, PAGES, shapeFile } from './scaling-pages-support.js';

// jsdom has no layout or ResizeObserver, which ECharts needs; the requests are what this test records, not the charts.
vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Vite rewrites `new URL(.., import.meta.url)` against the page's origin under jsdom, so the node engine's files are
// found here from the working directory (the root of the repository) instead.
vi.mock('../../test-support/host-engine-files.js', async () => {
  const { createRequire } = await import('node:module');
  const { dirname, join, resolve } = await import('node:path');
  return {
    packageHostEngineFiles: () => {
      const bindings = createRequire(resolve('package.json')).resolve(
        '@duckdb/duckdb-wasm/dist/duckdb-node.cjs',
      );
      const dist = dirname(bindings);
      const ext = (name: string): string =>
        resolve('.cache/duckdb-extensions', `${name}.duckdb_extension.wasm`);
      return {
        bindings,
        worker: join(dist, 'duckdb-node-eh.worker.cjs'),
        wasm: join(dist, 'duckdb-eh.wasm'),
        extensions: { parquet: ext('parquet'), json: ext('json') },
        close: async (): Promise<void> => {},
      };
    },
  };
});

const IDS = new Set(CATALOGUE.map((e) => e.id));
const { OTEL_HTML_SCALING: SCALING, OTEL_HTML_SCALING_OUT: OUT } = process.env;

/** Methods any rendering of the page must call: a page that records fewer lost a widget's request. */
const MUST_CALL: Record<string, readonly string[]> = {
  '#/dashboards/ci': ['querySpans', 'queryLogs', 'metricCatalog', 'metricRunQuery'],
  '#/traces?mode=traces': ['querySpans'],
  '#/traces': ['querySpans'],
  '#/logs': ['queryLogs'],
  '#/metrics': ['metricCatalog'],
};

let report: ScalingReport;
let close: () => Promise<void>;
let cold: () => Promise<void>;
let take: () => Promise<ReadEvent[]>;
let make: () => ReturnType<typeof createDuckDbDataSource>;

beforeAll(async () => {
  report = await buildScalingReport(BASE);
  const counting = await openCountingEngine(report.dir, report.manifest);
  close = async () => {
    await counting.close();
    await report.close();
  };
  cold = () => counting.cold();
  take = () => counting.take();
  make = () => createDuckDbDataSource({ engine: counting.engine, manifest: report.manifest });
}, 120_000);
afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await close();
});

describe('the pages ask only catalogued requests', () => {
  test.each(PAGES)(
    '%s',
    async (hash) => {
      const manifest = manifestWithCi(report.manifest, report.ids.metric);
      // a page opens the report cold: no footer or file content left in the engine by the page before
      await cold();
      const { ds, calls, settled } = recordingDataSource(make(), manifest);
      window.location.hash = hash;
      render(
        <ThemeProvider>
          <Shell dataSource={ds} history={createHashHistory(window)} />
        </ThemeProvider>,
      );
      await settled();
      const settledCount = calls.length;
      // nothing may start after the page counted as settled
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(calls.length, `${hash}: calls started after settled()`).toBe(settledCount);
      const warm = costOf(await take(), new Map());
      expect(calls.length).toBeGreaterThan(0);
      for (const method of MUST_CALL[hash] ?? [])
        expect(
          calls.map((c) => c.method),
          `${hash} calls ${method}`,
        ).toContain(method);
      for (const long of [false, true])
        for (const id of calls.flatMap((c) => entryIdsOf(c, long)))
          expect(IDS.has(id), `${hash}: ${id}`).toBe(true);
      if (OUT !== undefined) {
        const dir = join(OUT, 'recordings');
        mkdirSync(dir, { recursive: true });
        const mapped = calls.map((call) => ({
          call,
          ids: { short: entryIdsOf(call, false), long: entryIdsOf(call, true) },
        }));
        writeFileSync(
          join(dir, `${encodeURIComponent(hash)}.json`),
          JSON.stringify({ calls: mapped, warm }, null, 1),
        );
      }
    },
    60_000,
  );
});

const SPACINGS = ['dense', 'sparse'] as const;
/** The shapes of one worker: the big-partition shapes are in `scaling-pages-big.test.tsx` (their own heap). */
const smallShapes = (spacing: (typeof SPACINGS)[number]): Shape[] =>
  [...pageShapes(spacing), PAGE_CROSS(spacing)].filter((s) => s.bigRowGroups === undefined);

/**
 * Each page rendered whole in a cold counting engine on the page shapes, for `mise run predict:queries` (the folder of
 * OTEL_HTML_SCALING_OUT); the script fits them and runs the one-engine check.
 */
describe.skipIf(SCALING !== '1' || OUT === undefined)('a page is measured whole', () => {
  afterAll(async () => {
    await closeMeasured();
  });

  describe.each(SPACINGS)('%s', (spacing) => {
    test.each(smallShapes(spacing).map((shape) => [shapeFile(shape), shape] as const))(
      'the five pages on %s',
      async (_file, shape) => {
        await measureShape(shape, OUT ?? '');
      },
      600_000,
    );
  });
});
