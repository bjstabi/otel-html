import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { parse } from 'yaml';
import { ConfigSchema } from '../../src/config/schema.js';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { type Cost, costOf } from '../../test-support/scaling/cost.js';
import { openCountingEngine } from '../../test-support/scaling/counting-engine.js';
import { buildScalingReport, type ScalingReport, type Shape } from '../../test-support/scaling/generator.js';
import { recordingDataSource } from '../../test-support/scaling/recording-source.js';

// Shared by the two test files that render the pages; each has its own mocks and its own worker (its own heap).

export const PAGES = ['#/dashboards/ci', '#/traces?mode=traces', '#/traces', '#/logs', '#/metrics'] as const;

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
export function manifestWithCi(base: ManifestV4, metric: string): ManifestV4 {
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

/** A page in a cold counting engine over an existing report: what its file reads cost. */
async function pageOn(live: ScalingReport, hash: string): Promise<Cost> {
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
    return cost;
  } finally {
    cleanup();
    await counting.close();
  }
}

/** The file a shape's measurement goes to, under `pages/<page>/`. */
export const shapeFile = (shape: Shape): string =>
  `${shape.spacing}-${shape.outside}-${shape.inside}-${shape.rowGroups}${shape.bigRowGroups === undefined ? '' : `-big${shape.bigRowGroups}`}.json`;

/** The five pages rendered whole on the report of `shape`, one cold engine each; the costs go to `<out>/pages`. */
export async function measureShape(shape: Shape, out: string): Promise<void> {
  const live = await buildScalingReport(shape);
  try {
    for (const hash of PAGES) {
      const cost = await pageOn(live, hash);
      if (cost.serial <= 0) throw new Error(`${hash} on ${shapeFile(shape)} made no requests`);
      const dir = join(out, 'pages', encodeURIComponent(hash));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, shapeFile(shape)), JSON.stringify({ shape, ...cost }));
    }
  } finally {
    await live.close();
  }
}
