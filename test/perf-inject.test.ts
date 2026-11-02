import { describe, expect, test } from 'vitest';
import { checkedPerfFactor } from '../test-support/perf-inject.js';

describe('checkedPerfFactor', () => {
  test('returns a finite factor of at least 1', () => {
    expect(checkedPerfFactor(1)).toBe(1);
    expect(checkedPerfFactor(2.5)).toBe(2.5);
  });

  test.each([undefined, Number.NaN, 0.5, '2'])('throws for %j', (value) => {
    expect(() => checkedPerfFactor(value)).toThrow(/perf-global-setup/);
  });
});
