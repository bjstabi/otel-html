import { describe, expect, test } from 'vitest';
import { alignLongWindow, isLongWindow, LONG_WINDOW_NS } from '../../src/viewer/data/time-window.js';

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
