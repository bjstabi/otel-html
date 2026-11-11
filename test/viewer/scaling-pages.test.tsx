import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { parse } from 'yaml';
import { ConfigSchema } from '../../src/config/schema.js';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { CATALOGUE } from '../../src/viewer/data/catalogue.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { costOf } from '../../test-support/scaling/cost.js';
import { openCountingEngine, type ReadEvent } from '../../test-support/scaling/counting-engine.js';
import { BASE, buildScalingReport, type ScalingReport } from '../../test-support/scaling/generator.js';
import { entryIdsOf, recordingDataSource } from '../../test-support/scaling/recording-source.js';

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
const { OTEL_HTML_SCALING_OUT: OUT } = process.env;

const PAGES = ['#/dashboards/ci', '#/traces?mode=traces', '#/traces', '#/logs', '#/metrics'] as const;

/** `value` with the metric of every query set to `metric`: the report of the test holds one metric, not the CI's. */
function withMetric(value: unknown, metric: string): unknown {
  if (Array.isArray(value)) return value.map((v) => withMetric(v, metric));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      k === 'metric' && typeof v === 'string' ? metric : withMetric(v, metric),
    ]),
  );
}

/**
 * The shipped CI dashboard, with the statistics keys the writer adds for the variables of a dashboard and its metric
 * queries pointed at the metric of the generated report (a query of a metric the report lacks asks nothing).
 */
function manifestWithCi(base: ManifestV4, metric: string): ManifestV4 {
  const config = ConfigSchema.parse(
    withMetric(parse(readFileSync('.github/otel-html-ci.yaml', 'utf8')), metric),
  );
  const keys = config.dashboards.flatMap((d) =>
    (d.dashboard.variables ?? []).map((v) => `resource:${typeof v === 'string' ? v : v.key}`),
  );
  const withKeys = (list: string[]): string[] => [...list, ...keys];
  return {
    ...base,
    statisticsKeys: {
      ...base.statisticsKeys,
      spans: withKeys(base.statisticsKeys.spans),
      logs: withKeys(base.statisticsKeys.logs),
      points: withKeys(base.statisticsKeys.points),
    },
    config: { ...base.config, viewer: config.viewer, dashboards: config.dashboards },
  };
}

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
      const warm = costOf(await take(), new Map());
      expect(calls.length).toBeGreaterThan(0);
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
