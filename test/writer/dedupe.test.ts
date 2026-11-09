import { describe, expect, test } from 'vitest';
import { DedupeSet } from '../../src/writer/dedupe.js';

describe('DedupeSet', () => {
  test('records and reports prior presence', () => {
    const d = new DedupeSet(10);
    expect(d.seen('a', 'b')).toBe(false);
    expect(d.seen('a', 'b')).toBe(true);
    expect(d.seen('a', 'c')).toBe(false);
  });
  test('evicts first-in-first-out at capacity', () => {
    const d = new DedupeSet(2);
    d.seen('t', '1');
    d.seen('t', '2');
    d.seen('t', '1'); // seeing again does not refresh
    d.seen('t', '3'); // evicts 1
    expect(d.size).toBe(2);
    expect(d.seen('t', '1')).toBe(false);
  });
  test('round-trips in eviction order and trims to capacity', () => {
    const d = new DedupeSet(3);
    for (const s of ['1', '2', '3']) d.seen('t', s);
    expect(DedupeSet.from(d.toJSON(), 3).toJSON()).toEqual(d.toJSON());
    expect(DedupeSet.from(d.toJSON(), 2).toJSON()).toEqual(['t2', 't3']);
  });
  test('rejects a non-positive capacity', () => {
    expect(() => new DedupeSet(0)).toThrow(/dedupeCapacity/);
  });
});
