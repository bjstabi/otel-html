import { describe, expect, test } from 'vitest';
import { NUMBER_SHOWS } from '../../src/query/sql/points.js';
import type { MetricDef } from '../../src/viewer/data/metric-catalog.js';
import {
  COMBINE,
  DEFAULT_SHOW,
  defaultShowOf,
  kindOf,
  SHOW_BY_KIND,
} from '../../src/viewer/data/metric-tables.js';

const def = (over: Partial<MetricDef>): MetricDef => ({
  id: 0,
  name: 'm',
  description: '',
  unit: '',
  type: 'gauge',
  temporality: 'unspecified',
  monotonic: false,
  ...over,
});

describe('metric tables', () => {
  test('kinds, show options and defaults', () => {
    expect(kindOf(def({ type: 'sum', monotonic: true }))).toBe('counter');
    expect(kindOf(def({ type: 'sum', monotonic: false }))).toBe('number');
    expect(kindOf(def({ type: 'gauge', monotonic: false }))).toBe('number');
    expect(kindOf(def({ type: 'histogram', monotonic: false }))).toBe('hist');
    expect(kindOf(def({ type: 'exponentialHistogram', monotonic: false }))).toBe('exp');
    expect(kindOf(def({ type: 'summary', monotonic: false }))).toBe('summary');
    expect(SHOW_BY_KIND.counter).toEqual(['rate', 'increase', 'sum']);
    expect(DEFAULT_SHOW).toMatchObject({ counter: 'rate', number: 'avg', hist: 'p95', exp: 'p95' });
  });

  test('defaultShowOf gives a concrete option for every kind', () => {
    expect(defaultShowOf('counter', SHOW_BY_KIND.counter)).toBe('rate');
    expect(defaultShowOf('hist', SHOW_BY_KIND.hist)).toBe('p95');
    expect(defaultShowOf('summary', ['q0.5', 'q0.99', 'count', 'sum'])).toBe('q0.99');
    expect(defaultShowOf('summary', ['count', 'sum'])).toBe('count');
  });

  test('the SQL side combines number series as COMBINE.number says', () => {
    const rule = COMBINE.number;
    if (rule.rule !== 'across') throw new Error('number combines across series');
    const sqlAgg = { mean: 'avg', min: 'min', max: 'max', sum: 'sum' } as const;
    for (const [show, across] of Object.entries(rule.byShow)) {
      expect(NUMBER_SHOWS[show as keyof typeof NUMBER_SHOWS].across).toBe(sqlAgg[across]);
    }
    expect(Object.keys(NUMBER_SHOWS).sort()).toEqual(Object.keys(rule.byShow).sort());
  });
});
