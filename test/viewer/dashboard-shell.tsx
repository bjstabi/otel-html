import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { type Dashboard, DashboardSchema } from '../../src/dashboards/schema.js';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { LOG_SEVERITY_KEYS } from '../../src/semconv/severity.js';
import type { DataSource, ResourceValues } from '../../src/viewer/data/data-source.js';
import type { LogQueryResult, SpanQueryResult } from '../../src/viewer/data/results.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { manifestV4 } from './v4-manifest.js';

// jsdom has no layout or ResizeObserver, which ECharts needs; chart widgets are covered by their own tests.
vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));

const HOUR = 3_600_000_000_000;
const EPOCH = 1_700_000_000_000_000_000n;

/** A format-4 manifest whose run lasts ten hours from the epoch (`range` is absolute, as the writer stores it). */
export const baseManifest: ManifestV4 = {
  ...manifestV4(1234),
  title: 'Checkout load test',
  range: { start: EPOCH.toString(), end: (EPOCH + BigInt(10 * HOUR)).toString() },
};

/** A manifest with config dashboards and viewer overrides. */
export function manifestWith(
  dashboards: Dashboard[],
  viewer: Partial<ManifestV4['config']['viewer']> = {},
): ManifestV4 {
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

export const emptySpanResult = (): SpanQueryResult => ({
  rows: [],
  total: 0,
  facets: new FacetCounts(10, 10),
  buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
  red: null,
  durations: { summary: null, bins: [] },
  groups: null,
  residual: null,
  tables: { resources: [], scopes: [] },
});

export const emptyLogResult = (): LogQueryResult => ({
  mode: 'logs',
  rows: [],
  total: 0,
  matched: 0,
  facets: new FacetCounts(10, 10),
  buckets: new TimeBuckets(LOG_SEVERITY_KEYS, 8),
  residual: null,
});

/**
 * A fake format-4 source: every query answers empty until a test overrides it. The resource values per variable key;
 * a key left out has none in the report.
 */
export function dataSourceOf(
  manifest: ManifestV4,
  values: Readonly<Record<string, ResourceValues>> = {},
): DataSource {
  return {
    manifest,
    epoch: EPOCH,
    querySpans: () => Promise.resolve(emptySpanResult()),
    getTrace: unused,
    hasTrace: unused,
    percentileOf: unused,
    serviceShare: unused,
    services: () => Promise.resolve({ services: [], total: 0 }),
    queryLogs: () => Promise.resolve(emptyLogResult()),
    getLog: unused,
    traceLogs: unused,
    surroundingLogs: unused,
    patterns: () => Promise.resolve({ rows: [], total: 0 }),
    metricCatalog: () => Promise.resolve({ entries: [], resources: [], scopes: [] }),
    metricShowOptions: () => Promise.resolve([]),
    metricQuery: unused,
    metricRunQuery: unused,
    metricPoints: () => Promise.resolve(new TimeBuckets(['points'], 8)),
    metricsForResources: () => Promise.resolve([]),
    resourceValues: (key) => Promise.resolve(values[key] ?? { values: [], kind: 'string', capped: false }),
    close: () => Promise.resolve(),
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
