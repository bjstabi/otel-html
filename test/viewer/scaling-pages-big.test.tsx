import { afterAll, describe, test, vi } from 'vitest';
import { pageShapes } from '../../test-support/scaling/generator.js';
import { closeMeasured } from '../../test-support/scaling/measure.js';
import { measureShape, shapeFile } from './scaling-pages-support.js';

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

const { OTEL_HTML_SCALING: SCALING, OTEL_HTML_SCALING_OUT: OUT } = process.env;

/**
 * The page shapes with one large partition (8, 14 and 22 production-size groups: a real report has one), apart from
 * `scaling-pages.test.tsx` because a report of a million spans needs a heap of its own.
 */
describe.skipIf(SCALING !== '1' || OUT === undefined)(
  'a page is measured whole with a large partition',
  () => {
    afterAll(async () => {
      await closeMeasured();
    });

    describe.each(['dense', 'sparse'] as const)('%s', (spacing) => {
      test.each(
        pageShapes(spacing)
          .filter((s) => s.bigRowGroups !== undefined)
          .map((shape) => [shapeFile(shape), shape] as const),
      )(
        'the five pages on %s',
        async (_file, shape) => {
          await measureShape(shape, OUT ?? '');
        },
        900_000,
      );
    });
  },
);
