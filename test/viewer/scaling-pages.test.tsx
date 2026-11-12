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
import {
  BASE,
  buildScalingReport,
  CROSS,
  type ScalingReport,
  type Shape,
} from '../../test-support/scaling/generator.js';
import { closeMeasured, DENSE_16, fitOf } from '../../test-support/scaling/measure.js';
import { countCalls, improvedFit, type PageEntry, predictPage } from '../../test-support/scaling/model.js';
import {
  entryIdsOf,
  type RecordedCall,
  recordingDataSource,
} from '../../test-support/scaling/recording-source.js';

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

/** A page in one counting engine over the report of `shape`: the calls it made and what its file reads cost. */
async function pageOn(shape: Shape, hash: string): Promise<{ calls: RecordedCall[]; serial: number }> {
  const live = await buildScalingReport(shape);
  const counting = await openCountingEngine(live.dir, live.manifest);
  try {
    const manifest = manifestWithCi(live.manifest, live.ids.metric);
    await counting.cold();
    const recording = recordingDataSource(
      createDuckDbDataSource({ engine: counting.engine, manifest: live.manifest }),
      manifest,
    );
    window.location.hash = hash;
    render(
      <ThemeProvider>
        <Shell dataSource={recording.ds} history={createHashHistory(window)} />
      </ThemeProvider>,
    );
    await recording.settled();
    const cost = costOf(await counting.take(), new Map());
    cleanup();
    return { calls: recording.calls, serial: cost.serial };
  } finally {
    cleanup();
    await counting.close();
    await live.close();
  }
}

/** Within this share of the page's cost in one engine the prediction counts as right (the plan's tolerance). */
const TOLERANCE = 0.25;
const SHAPES: readonly (readonly [string, Shape])[] = [
  ['BASE', BASE],
  ['CROSS', CROSS],
  ['rowGroups 16', { ...BASE, rowGroups: DENSE_16 }],
];

describe.skipIf(SCALING !== '1')('a page is predicted from the union of its entries reads', () => {
  afterAll(async () => {
    await closeMeasured();
  });

  test.each(SHAPES.flatMap(([name, shape]) => PAGES.map((hash) => [name, hash, shape] as const)))(
    '%s %s',
    async (name, hash, shape) => {
      const { calls, serial } = await pageOn(shape, hash);
      // the page's window spans the report, so every partition is inside it; the dense shapes are short windows
      const partitions = Array.from({ length: shape.outside + shape.inside }, () => ({
        rowGroups: shape.rowGroups,
        inWindow: true,
        smallFiles: 0,
      }));
      const counted = countCalls(
        calls.map((call) => ({
          method: call.method,
          idKey: call.idKey,
          ids: entryIdsOf(call, false),
          baseline: false,
        })),
      );
      const entries: PageEntry[] = [];
      for (const [key, times] of counted) {
        const entry = CATALOGUE.find((e) => e.id === key.split('|')[0]);
        if (entry === undefined) throw new Error(`no catalogue entry for ${key}`);
        entries.push({ fit: improvedFit(await fitOf(entry), {}), times, filesAxes: [] });
      }
      const predicted = predictPage(entries, partitions).serial;
      if (OUT !== undefined) {
        const dir = join(OUT, 'one-engine');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, `${name.replaceAll(' ', '-')}-${encodeURIComponent(hash)}.json`),
          JSON.stringify({ shape: name, page: hash, predicted, measured: serial }),
        );
      }
      expect(serial, `${name} ${hash} measured`).toBeGreaterThan(0);
      expect(
        Math.abs(predicted - serial) / serial,
        `${name} ${hash}: predicted ${predicted}, measured ${serial}`,
      ).toBeLessThanOrEqual(TOLERANCE);
    },
    600_000,
  );
});
