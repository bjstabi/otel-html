import { expect, test } from 'vitest';
import { parseAnyManifest } from '../../src/format/manifest.js';
import { manifestRange } from '../../src/viewer/data/manifest-range.js';
import { keepAnchor } from '../../src/viewer/data/refresh-report.js';
import { relTime } from '../../src/viewer/data/span-results.js';

const YEAR = 365n * 86_400n * 1_000_000_000n;
const START = 1_700_000_000_000_000_000n;

const body = (range: { start: bigint; end: bigint } | null): unknown => ({
  formatVersion: 6,
  otelHtmlVersion: '0.3.0',
  title: 't',
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:01.000Z',
  complete: true,
  range: range === null ? null : { start: String(range.start), end: String(range.end) },
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

test('a format-6 range three years wide is returned, rounded, without a throw', () => {
  const m = parseAnyManifest(body({ start: START, end: START + 3n * YEAR }));
  expect(manifestRange(m)).toEqual({ start: 0, end: Number(3n * YEAR) });
  expect(Number(3n * YEAR)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
});

test('relTime rounds beyond 2^53 and keeps small values exact', () => {
  expect(relTime(2n ** 60n + 1n, 'x')).toBe(2 ** 60);
  expect(relTime(-5n, 'x')).toBe(-5);
  expect(relTime(7, 'x')).toBe(7);
});

test('a refresh keeps the first load anchor of a format-6 report even when older data appears', () => {
  const first = parseAnyManifest(body({ start: START, end: START + YEAR }));
  const grown = parseAnyManifest(body({ start: START - YEAR, end: START + YEAR }));
  if (first.formatVersion !== 6 || grown.formatVersion !== 6) throw new Error('not format 6');
  expect(grown.epochUnixNano).toBe(String(START - YEAR));
  const kept = keepAnchor(grown, first);
  expect(kept.epochUnixNano).toBe(String(START));
  // the older range is then a negative start, relative to the kept anchor
  expect(manifestRange(kept)).toEqual({ start: -Number(YEAR), end: Number(YEAR) });
});
