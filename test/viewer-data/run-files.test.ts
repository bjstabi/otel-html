import { describe, expect, test } from 'vitest';
import type { Attributes } from '../../src/model/anyvalue.js';
import { byExpr } from '../../src/query/sql/points.js';
import type { SeriesRow } from '../../src/viewer/data/metric-results.js';
import { leftOutOf, runStatisticsKey, runValues } from '../../src/viewer/data/run-files.js';

describe('runStatisticsKey', () => {
  test.each([
    ['resource.attributes["cicd.pipeline.run.id"]', 'resource:cicd.pipeline.run.id'],
    ['resource.attributes["run.id"]', 'resource:run.id'],
    ['attributes["run.id"]', null],
    ['resource.attributes["a"] + "x"', null],
    ['resource.attributes["a"]["b"]', null],
    ['not a path (', null],
  ])('runStatisticsKey(%s) is %s', (by, key) => expect(runStatisticsKey(by)).toBe(key));
});

const series = (
  id: string,
  resource: [string, unknown][],
  attributes: [string, string][] = [],
): SeriesRow => {
  const toValue = (v: unknown) =>
    v === null ? { kind: 'empty' as const } : { kind: 'string' as const, value: String(v) };
  return {
    seriesId: id,
    description: '',
    attributes: new Map(attributes.map(([k, v]) => [k, toValue(v)])) as Attributes,
    resource: {
      attributes: new Map(resource.map(([k, v]) => [k, toValue(v)])) as Attributes,
      droppedAttributesCount: 0,
      schemaUrl: '',
    },
    scope: { name: '', version: '', attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' },
    bounds: null,
    groups: [],
  };
};

describe('leftOutOf', () => {
  const by = byExpr('resource.attributes["run"]');
  const all = () => true;
  test('counts series whose run value is missing, null or empty, once per series id', () => {
    const rows = [
      series('a', [['run', 'r1']]),
      series('b', []),
      series('c', [['run', '']]),
      series('d', [['run', null]]),
      // the same series stored twice (its attribute JSON in two key orders)
      series('e', [['x', 'y']]),
      series('e', [['x', 'y']]),
    ];
    expect(leftOutOf(rows, all, by)).toBe(4);
  });
  test('only the series that pass the test count', () => {
    const rows = [series('a', [], [['job', 'build']]), series('b', [], [['job', 'check']])];
    expect(leftOutOf(rows, (r) => r.attributes.get('job')?.kind === 'string' && r.seriesId === 'b', by)).toBe(
      1,
    );
  });
  test('a run expression other than a plain resource attribute is left to SQL', () => {
    expect(leftOutOf([series('a', [])], all, byExpr('attributes["run"]'))).toBeNull();
    expect(leftOutOf([series('a', [])], all, byExpr('resource.attributes["0"]'))).toBeNull();
  });
});

describe('runValues', () => {
  test('string runs name statistics values; any other run names none', () => {
    expect([...(runValues(['"a"', '"b c"']) ?? [])]).toEqual(['a', 'b c']);
    expect(runValues(['"a"', '5'])).toBeNull();
  });
});
