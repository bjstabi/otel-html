import { describe, expect, test } from 'vitest';
import { type RequestShape, type RouteNeed, rawOnly, routeOf } from '../../src/viewer/data/route.js';

const shape = (over: Partial<RequestShape>): RequestShape => ({
  table: 'spans',
  need: 'total',
  mode: 'spans',
  long: true,
  reads: new Set<string>(),
  residual: false,
  text: false,
  ...over,
});

const MEASURED_NEEDS: readonly (readonly ['spans' | 'logs', RouteNeed])[] = [
  ['spans', 'total'],
  ['spans', 'timeline'],
  ['spans', 'buckets'],
  ['spans', 'groups'],
  ['spans', 'durations'],
  ['spans', 'services'],
  ['spans', 'facets'],
  ['logs', 'total'],
  ['logs', 'timeline'],
  ['logs', 'facets'],
];

describe('routeOf', () => {
  test.each(MEASURED_NEEDS)(
    '%s %s is built over measures under a long window and directly under a short one',
    (table, need) => {
      const mode = table === 'spans' ? 'spans' : 'logs';
      expect(routeOf(shape({ table, need, mode, long: true }))).toBe('measures');
      expect(routeOf(shape({ table, need, mode, long: false }))).toBe('direct');
    },
  );

  test('a condition does not change the route: the same number has one computation', () => {
    for (const over of [
      { reads: new Set(['service_name']) },
      { reads: new Set(['attr:http.route']) },
      { reads: new Set(['resource:*']) },
      { residual: true },
      { text: true },
    ]) {
      expect(routeOf(shape({ need: 'timeline', ...over }))).toBe('measures');
    }
  });

  test('rows, attribute facets and a distinct-trace count are direct under a long window', () => {
    expect(routeOf(shape({ need: 'rows' }))).toBe('direct');
    expect(routeOf(shape({ need: 'attributeFacets' }))).toBe('direct');
    expect(routeOf(shape({ table: 'logs', need: 'attributeFacets', mode: 'logs' }))).toBe('direct');
    expect(routeOf(shape({ need: 'total', mode: 'traces' }))).toBe('direct');
    expect(routeOf(shape({ table: 'logs', need: 'total', mode: 'traces' }))).toBe('direct');
    expect(routeOf(shape({ table: 'logs', need: 'rows', mode: 'logs' }))).toBe('direct');
  });

  test('a need a table does not have is direct', () => {
    expect(routeOf(shape({ table: 'logs', need: 'groups', mode: 'logs' }))).toBe('direct');
    expect(routeOf(shape({ table: 'logs', need: 'durations', mode: 'logs' }))).toBe('direct');
  });
});

describe('rawOnly', () => {
  test('a text search, a residual term and a whole-map read; not a named resource or attribute key', () => {
    expect(rawOnly(shape({ text: true }))).toBe(true);
    expect(rawOnly(shape({ residual: true }))).toBe(true);
    expect(rawOnly(shape({ reads: new Set(['resource:*']) }))).toBe(true);
    expect(rawOnly(shape({ reads: new Set(['attr:*']) }))).toBe(true);
    expect(rawOnly(shape({ reads: new Set(['resource:run.id']) }))).toBe(false);
    expect(rawOnly(shape({ reads: new Set(['attr:http.route', 'service_name']) }))).toBe(false);
    expect(rawOnly(shape({}))).toBe(false);
  });
});
