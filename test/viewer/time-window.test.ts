import { describe, expect, test } from 'vitest';
import {
  alignedIn,
  alignLongWindow,
  defaultWindowOf,
  durationNs,
  isLongWindow,
  LONG_WINDOW_NS,
  presetMatches,
} from '../../src/viewer/data/time-window.js';

const EPOCH = 1_700_000_000_000_000_000n;
const GRAIN = 65_536_000_000n;

describe('isLongWindow', () => {
  test('exactly 256 grains is long; one nanosecond less is short', () => {
    expect(LONG_WINDOW_NS).toBe(16_777_216_000_000);
    expect(isLongWindow({ start: 0, end: 16_777_216_000_000 }, null)).toBe(true);
    expect(isLongWindow({ start: 0, end: 16_777_215_999_999 }, null)).toBe(false);
  });
  test('no window on a range of exactly 256 grains is long; on a shorter range it is short', () => {
    expect(isLongWindow(null, { start: 5, end: 5 + LONG_WINDOW_NS })).toBe(true);
    expect(isLongWindow(null, { start: 5, end: 4 + LONG_WINDOW_NS })).toBe(false);
    expect(isLongWindow(null, null)).toBe(false);
  });
  test('with a known range the window is clipped to it: a long window on a short report is short', () => {
    const hour = 3_600_000_000_000;
    expect(isLongWindow({ start: hour, end: 7 * hour }, { start: 0, end: 2 * hour })).toBe(false);
    expect(isLongWindow({ start: -hour, end: 7 * hour }, { start: 0, end: 6 * hour })).toBe(true);
    expect(isLongWindow({ start: 0, end: 7 * hour }, null)).toBe(true);
  });
  test('a window decides over the range', () => {
    expect(isLongWindow({ start: 0, end: 1 }, { start: 0, end: 10 * LONG_WINDOW_NS })).toBe(false);
  });
});

describe('alignLongWindow', () => {
  test('moves outward to absolute grains and is idempotent', () => {
    const w = alignLongWindow({ start: 1, end: 16_777_216_000_001 }, EPOCH);
    expect((EPOCH + BigInt(w.start)) % GRAIN).toBe(0n);
    expect((EPOCH + BigInt(w.end)) % GRAIN).toBe(0n);
    expect(w.start).toBeLessThanOrEqual(1);
    expect(w.end).toBeGreaterThanOrEqual(16_777_216_000_001);
    expect(alignLongWindow(w, EPOCH)).toEqual(w);
  });
});

describe('durationNs and defaultWindowOf', () => {
  test('durationNs', () => {
    expect(durationNs('7d')).toBe(604_800_000_000_000);
    expect(durationNs('90m')).toBe(5_400_000_000_000);
    expect(durationNs('6h')).toBe(21_600_000_000_000);
  });
  test('the default is anchored at the end of the range; absent, or not shorter than the range, is null', () => {
    const range = { start: 0, end: 12 * 3_600_000_000_000 };
    expect(defaultWindowOf('6h', range)).toEqual({ start: 6 * 3_600_000_000_000, end: range.end });
    expect(defaultWindowOf(undefined, range)).toBeNull();
    expect(defaultWindowOf('12h', range)).toBeNull();
    expect(defaultWindowOf('7d', range)).toBeNull();
    expect(defaultWindowOf('6h', null)).toBeNull();
  });
});

describe('presetMatches', () => {
  const HOUR = 3_600_000_000_000;
  const range = { start: 0, end: 12 * HOUR };
  test('a short preset is the window anchored at the end; a long one after alignment; none when the run is not longer', () => {
    expect(presetMatches({ start: 11 * HOUR, end: 12 * HOUR }, HOUR, range, EPOCH)).toBe(true);
    expect(presetMatches({ start: 10 * HOUR, end: 12 * HOUR }, HOUR, range, EPOCH)).toBe(false);
    const six = alignedIn({ start: 6 * HOUR, end: 12 * HOUR }, EPOCH, range);
    expect(six).not.toBeNull();
    if (six !== null) expect(presetMatches(six, 6 * HOUR, range, EPOCH)).toBe(true);
    expect(presetMatches({ start: 6 * HOUR, end: 12 * HOUR }, 6 * HOUR, range, EPOCH)).toBe(false);
    expect(presetMatches({ start: 0, end: 12 * HOUR }, 12 * HOUR, range, EPOCH)).toBe(false);
  });
});
