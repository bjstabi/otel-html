import { describe, expect, test } from 'vitest';
import type { UnixNanos } from '../../../src/model/ids.js';
import {
  axisTime,
  durationAxis,
  durationText,
  shortTime,
  tickText,
} from '../../../src/viewer/cicd/format.js';

const MS = 1_000_000;
const HOUR = 3_600_000 * MS;
const epoch = (BigInt(Date.UTC(2026, 10, 11, 13, 10, 15, 296)) * 1_000_000n) as UnixNanos;
const tz = 'Asia/Tokyo';

describe('durationText', () => {
  test('zero reads 0 s, anything else as formatDuration', () => {
    expect(durationText(0)).toBe('0 s');
    expect(durationText(1500 * MS)).toBe('1.5 s');
    expect(durationText(5)).toBe('5 ns');
    expect(durationText(312 * MS)).toBe('312 ms');
    expect(durationText(59_600 * MS)).toBe('59.6 s');
  });

  test('minutes and hours read in whole numbers', () => {
    const S = 1e9;
    expect(durationText(60 * S)).toBe('1 min');
    expect(durationText(252 * S)).toBe('4 min 12 s');
    expect(durationText(300 * S)).toBe('5 min');
    expect(durationText(3900 * S)).toBe('1 h 5 min');
    expect(durationText(7200 * S)).toBe('2 h');
  });

  test('rounded seconds carry into the minute, rounded minutes into the hour', () => {
    const S = 1e9;
    expect(durationText(299.7 * S)).toBe('5 min');
    expect(durationText(3599.7 * S)).toBe('1 h');
    expect(durationText(3599.7 * S + 3600 * S)).toBe('2 h');
    expect(durationText(7170 * S)).toBe('2 h');
  });

  test('hours round the minutes from the duration, not from rounded seconds', () => {
    expect(durationText(3689.6 * 1e9)).toBe('1 h 1 min');
  });

  test('a non-finite duration is the shared formatter text', () => {
    expect(durationText(Number.NaN)).toBe('NaN');
    expect(durationText(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });

  test('a negative duration is the minus sign and the magnitude', () => {
    expect(durationText(-252e9)).toBe('-4 min 12 s');
    expect(durationText(-1500 * MS)).toBe('-1.5 s');
  });
});

describe('durationAxis', () => {
  test('round steps in nanoseconds', () => {
    expect(durationAxis(1_840e9)).toEqual({ max: 2_700e9, interval: 900e9 });
    expect(durationAxis(7_300e9)).toEqual({ max: 9_000e9, interval: 1_800e9 });
    expect(durationAxis(0)).toEqual({ max: 1e9, interval: 1e9 });
  });
});

describe('shortTime', () => {
  test('is a local date and time without seconds, milliseconds or a zone letter', () => {
    const t = shortTime(0, epoch, tz);
    expect(t).not.toMatch(/\.\d{3}|Z|T/);
    expect(t).toContain('Nov');
    expect(t).toContain('10'); // 22:10 in Tokyo
  });
});

describe('axisTime', () => {
  test('a step under a day shows date and time, a day or more the date only', () => {
    expect(axisTime(0, epoch, HOUR, tz)).toMatch(/\d:\d\d|\d\d/);
    expect(axisTime(0, epoch, HOUR, tz)).toContain('\n');
    expect(axisTime(0, epoch, 24 * HOUR, tz)).not.toContain('\n');
    expect(axisTime(0, epoch, 24 * HOUR, tz)).not.toMatch(/\d:\d\d/);
    expect(axisTime(0, epoch, 24 * HOUR, tz)).toContain('Nov');
  });
});

describe('tickText', () => {
  test('axis ticks read in the run charts compact form', () => {
    expect(tickText(0)).toBe('0s');
    expect(tickText(30e9)).toBe('30s');
    expect(tickText(90e9)).toBe('1m 30s');
    expect(tickText(5_400e9)).toBe('1h 30m');
  });
});
