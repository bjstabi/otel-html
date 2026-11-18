import { describe, expect, test } from 'vitest';
import { humanDur, rangeLabel } from '../../src/viewer/dashboards/range-label.js';

const MIN = 60_000_000_000;
const DAY = 86_400_000_000_000;

describe('humanDur', () => {
  test('minutes, hours, days', () => {
    expect(humanDur(30 * MIN)).toBe('30 minutes');
    expect(humanDur(90 * MIN)).toBe('2 hours');
    expect(humanDur(3.5 * DAY)).toBe('3.5 days');
    expect(humanDur(7 * DAY)).toBe('7 days');
  });
});

describe('rangeLabel', () => {
  const extent: [number, number] = [0, 7 * DAY];
  test('no zoom gives the preset', () => {
    expect(rangeLabel({ preset: '7d', extent, zoom: null })).toMatchObject({
      label: 'last 7 days',
      of: null,
      zoomed: false,
    });
    expect(rangeLabel({ preset: null, extent, zoom: null }).label).toBe('custom');
  });
  test('a zoom to the end is last N', () => {
    expect(rangeLabel({ preset: '7d', extent, zoom: [3 * DAY, 7 * DAY] })).toMatchObject({
      label: 'last 4 days',
      of: ' of 7 days',
      zoomed: true,
    });
  });
  test('a zoom with the end moved is custom and the header names dates and duration', () => {
    const r = rangeLabel({ preset: '7d', extent, zoom: [1 * DAY, 5 * DAY] });
    expect(r.label).toBe('custom');
    expect(r.header).toBe('1970-01-02 00:00 – 1970-01-06 00:00 · 4 days');
  });
});
