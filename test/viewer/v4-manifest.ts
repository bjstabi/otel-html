import type { ManifestV4 } from '../../src/format/manifest.js';

const EPOCH = 1_700_000_000_000_000_000n;

/** A format-4 manifest for page tests: no partitions, a one-second range, 56 logs and 7 data points. */
export function manifestV4(spans: number, listCap = 100): ManifestV4 {
  return {
    formatVersion: 5,
    otelHtmlVersion: '0.0.0',
    title: 'run',
    epochUnixNano: EPOCH.toString(),
    createdAt: '2023-11-14T22:13:20.000Z',
    updatedAt: '2023-11-14T22:13:20.000Z',
    complete: true,
    range: { start: EPOCH.toString(), end: (EPOCH + 1_000_000_000n).toString() },
    totals: { spans, logs: 56, metrics: 7 },
    partitions: [],
    statisticsKeys: { spans: [], logs: [], points: [], traces: [], patterns: [] },
    engine: { version: '1.4.1', format: 'local', assetsBase: 'assets/' },
    config: {
      viewer: {
        listCap,
        theme: 'system',
        defaultDashboard: 'fusion',
        home: 'traces',
      },
      dashboards: [],
      views: [],
    },
  };
}
