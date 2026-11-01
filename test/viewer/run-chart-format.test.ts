import { describe, expect, test } from 'vitest';
import {
  formatTick,
  niceAxis,
  runDateTime,
  shortLabel,
} from '../../src/viewer/components/run-chart-format.js';

describe('niceAxis', () => {
  test('durations step through the fixed list', () => {
    expect(niceAxis(1254, 's', 5)).toEqual({ min: 0, max: 1500, interval: 300 });
    expect(niceAxis(404, 's', 5)).toEqual({ min: 0, max: 480, interval: 120 });
    expect(niceAxis(37, 's', 3)).toEqual({ min: 0, max: 45, interval: 15 });
  });

  test('converts the unit before picking a step', () => {
    expect(niceAxis(404000, 'ms', 5)).toEqual({ min: 0, max: 480000, interval: 120000 });
  });

  test('doubles 2 h past the list', () => {
    expect(niceAxis(60000, 's', 5).interval).toBe(14400);
  });

  test('plain counts use 1-2-5 steps', () => {
    const a = niceAxis(87, '{request}', 5);
    expect(a.interval).toBe(20);
    expect(a.max).toBe(100);
  });

  test('sub-second durations use 1-2-5 steps in their own unit', () => {
    expect(niceAxis(500, 'ms', 5)).toEqual({ min: 0, max: 500, interval: 100 });
  });

  test('zero still gives a positive max', () => {
    expect(niceAxis(0, 's', 5).max).toBeGreaterThan(0);
    expect(niceAxis(0, '{request}', 5).max).toBeGreaterThan(0);
  });
});

describe('formatTick', () => {
  test('durations read in s, m and h', () => {
    expect(formatTick(0, 's')).toBe('0s');
    expect(formatTick(30, 's')).toBe('30s');
    expect(formatTick(300, 's')).toBe('5m');
    expect(formatTick(5400, 's')).toBe('1h 30m');
    expect(formatTick(120000, 'ms')).toBe('2m');
  });

  test('other units use formatMetricValue', () => {
    expect(formatTick(20, '{request}')).toBe('20');
  });
});

describe('shortLabel', () => {
  test('keeps the part before the parentheses and the last part inside', () => {
    expect(shortLabel('binary (ubuntu-24.04-arm, linux-arm64)')).toBe('binary linux-arm64');
    expect(shortLabel('e2e (firefox)')).toBe('e2e firefox');
    expect(shortLabel('build')).toBe('build');
  });
});

describe('runDateTime', () => {
  test('uses the given time zone, not UTC', () => {
    // 2026-10-30T02:30:00Z is still Oct 29, 22:30 in New York (EDT).
    const ms = Date.UTC(2026, 9, 30, 2, 30);
    const r = runDateTime(String(BigInt(ms) * 1_000_000n), 0, 'America/New_York');
    expect(r.date).toBe(
      new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        timeZone: 'America/New_York',
      }).format(ms),
    );
    expect(r.date).toMatch(/29/);
    expect(r.time).toMatch(/22|10/);
    expect(r.time).toMatch(/30/);
  });

  test('adds the relative nanos', () => {
    const ms = Date.UTC(2026, 9, 30, 12, 0);
    const r = runDateTime(String(BigInt(ms) * 1_000_000n), 3_600_000_000_000, 'UTC');
    expect(r.time).toMatch(/1:00|13:00|01:00 PM|1:00 PM/);
  });
});
