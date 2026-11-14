import { expect, test } from 'vitest';
import { parseAnyManifest } from '../../src/format/manifest.js';
import { oldFormatMessage } from '../../src/format/version.js';
import { manifestRange } from '../../src/viewer/data/manifest-range.js';
import { requireFormat4 } from '../../src/viewer/data/require-format4.js';

const body = (formatVersion: number): unknown => ({
  formatVersion,
  otelHtmlVersion: '0.3.0',
  title: 't',
  epochUnixNano: '1700000000000000000',
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:01.000Z',
  complete: true,
  range: { start: '1700000000000000005', end: '1700000000000000010' },
  totals: { spans: 0, logs: 0, metrics: 0 },
  partitions: [],
  statisticsKeys: { spans: [], logs: [], points: [], traces: [], patterns: [] },
  engine: { version: '1.4.1', format: 'site', assetsBase: 'assets/' },
  config: {
    viewer: { listCap: 10_000, theme: 'system', defaultDashboard: 'fusion', home: 'traces' },
    dashboards: [],
    views: [],
  },
});

test.each([
  ['requireFormat4', (v: number) => requireFormat4(parseAnyManifest(body(v)))],
  ['manifestRange', (v: number) => manifestRange(parseAnyManifest(body(v)))],
])('%s accepts a format-5 manifest and refuses format 4 with the old-format message', (_name, gate) => {
  expect(() => gate(5)).not.toThrow();
  expect(() => gate(4)).toThrow(oldFormatMessage(4));
});

test('manifestRange reads a format-5 range relative to the epoch', () => {
  expect(manifestRange(parseAnyManifest(body(5)))).toEqual({ start: 5, end: 10 });
});
