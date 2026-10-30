import { expect, test } from 'vitest';
import { runnerFactor } from '../test-support/perf-factor.js';

test('a runner no slower than the reference keeps the budgets as written', () => {
  expect(runnerFactor(100, 85)).toBe(1);
});

test('a slower runner scales the budgets by how much slower it is', () => {
  expect(runnerFactor(100, 150)).toBe(1.5);
});

test('without a reference (or a usable one) the factor is 1', () => {
  expect(runnerFactor(undefined, 150)).toBe(1);
  expect(runnerFactor(0, 150)).toBe(1);
});
