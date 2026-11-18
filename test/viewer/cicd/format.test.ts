import { describe, expect, test } from 'vitest';
import type { UnixNanos } from '../../../src/model/ids.js';
import { axisTime, durationText, shortTime } from '../../../src/viewer/cicd/format.js';

const MS = 1_000_000;
const HOUR = 3_600_000 * MS;
const epoch = (BigInt(Date.UTC(2026, 10, 11, 13, 10, 15, 296)) * 1_000_000n) as UnixNanos;
const tz = 'Asia/Tokyo';

describe('durationText', () => {
  test('zero reads 0 s, anything else as formatDuration', () => {
    expect(durationText(0)).toBe('0 s');
    expect(durationText(1500 * MS)).toBe('1.5 s');
    expect(durationText(5)).toBe('5 ns');
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
