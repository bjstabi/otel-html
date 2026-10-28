import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { type Dashboard, DashboardSchema } from '../../src/dashboards/schema.js';
import type { Manifest } from '../../src/format/manifest.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { RedSeries } from '../../src/rollups/red.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { LOG_SEVERITY_KEYS } from '../../src/semconv/severity.js';
import type { DataSource, ResourceValues } from '../../src/viewer/data/data-source.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';

// jsdom has no layout or ResizeObserver, which ECharts needs; chart widgets are covered by their own tests.
vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));

const HOUR = 3_600_000_000_000;
export const EPOCH = '1700000000000000000';

export const baseManifest: Manifest = {
  formatVersion: 1,
  otelHtmlVersion: '0.0.0',
  title: 'Checkout load test',
  epochUnixNano: EPOCH,
  createdAt: '2023-11-14T22:13:20.000Z',
  updatedAt: '2023-11-14T22:13:20.000Z',
  complete: true,
  range: { start: 0, end: 10 * HOUR },
  totals: { spans: 1234, logs: 56, metrics: 7 },
  decodedBytes: 1000,
  chunks: [],
  rollups: [],
  traceShards: [],
  metricFiles: [],
  config: {
    viewer: {
      eagerBudgetBytes: 75_000_000,
      listCap: 10_000,
      theme: 'system',
      defaultDashboard: 'fusion',
      home: 'traces',
    },
    dashboards: [],
    views: [],
  },
};

/** A manifest with config dashboards and viewer overrides. */
export function manifestWith(
  dashboards: Dashboard[],
  viewer: Partial<Manifest['config']['viewer']> = {},
): Manifest {
  return {
    ...baseManifest,
    config: {
      ...baseManifest.config,
      viewer: { ...baseManifest.config.viewer, ...viewer },
      dashboards: dashboards.map((dashboard) => ({ source: 'otel-html.yaml', dashboard })),
    },
  };
}

export const CHECKOUT: Dashboard = DashboardSchema.parse({
  id: 'checkout',
  title: 'Checkout service',
  description: 'HTTP RED metrics for checkout',
  variables: ['service.name'],
  widgets: [
    { type: 'timeline', x: 0, y: 0, w: 12, h: 6 },
    { type: 'traces', x: 0, y: 6, w: 6, h: 10 },
    { type: 'logs', x: 6, y: 6, w: 6, h: 10 },
  ],
});

function unused(): never {
  throw new Error('this test must not reach that part of the data source');
}

/** The resource values per variable key; a key left out has none in the report. */
export function dataSourceOf(
  manifest: Manifest,
  values: Readonly<Record<string, ResourceValues>> = {},
): DataSource {
  return {
    manifest,
    strategy: 'eager',
    landing: () =>
      Promise.resolve({
        facets: new FacetCounts(10, 10),
        buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
        red: new RedSeries(8),
        durations: new Map(),
      }),
    querySpans: () =>
      Promise.resolve({
        rows: [],
        total: 0,
        facets: new FacetCounts(10, 10),
        buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
        red: new RedSeries(8),
        partial: null,
      }),
    getTrace: unused,
    hasTrace: unused,
    percentileOf: unused,
    logStrategy: 'eager',
    logLanding: unused,
    queryLogs: () =>
      Promise.resolve({
        mode: 'logs',
        rows: [],
        total: 0,
        matched: 0,
        facets: new FacetCounts(10, 10),
        buckets: new TimeBuckets(LOG_SEVERITY_KEYS, 8),
        partial: null,
      }),
    getLog: unused,
    traceLogs: unused,
    surroundingLogs: unused,
    metricCatalog: unused,
    metricPoints: () => Promise.resolve(new TimeBuckets(['points'], 8)),
    metric: unused,
    metricsForResources: unused,
    resourceValues: (key) => Promise.resolve(values[key] ?? { values: [], kind: 'string', capped: false }),
  };
}

export function renderShell(hash: string, ds: DataSource): void {
  window.location.hash = hash;
  render(
    <ThemeProvider>
      <Shell dataSource={ds} history={createHashHistory(window)} />
    </ThemeProvider>,
  );
}

/** The `d` URL key as the page currently holds it. */
export function currentD(): ReturnType<typeof parseUrlState>['state']['d'] {
  return parseUrlState(window.location.hash).state.d;
}
