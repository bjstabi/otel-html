import { describe, expect, test } from 'vitest';
import type { AnyValue } from '../../src/model/anyvalue.js';
import type { ResourceRecord } from '../../src/model/records.js';
import { explorerFilter } from '../../src/viewer/metrics/metric-grid.js';

describe('explorerFilter', () => {
  const str = (value: string): AnyValue => ({ kind: 'string', value });
  const res = (attrs: [string, AnyValue][]): ResourceRecord => ({
    attributes: new Map(attrs),
    droppedAttributesCount: 0,
    schemaUrl: '',
  });
  const svc: [string, AnyValue] = ['service.name', str('a')];

  test('excludes a matching resource by one of its extra attributes, and leaves non-matching ones alone', () => {
    const origin = res([svc]);
    const f = explorerFilter(
      [origin],
      [origin, res([svc, ['b', str('1')], ['c', str('2')]]), res([['service.name', str('z')]])],
    );
    expect(f).toEqual({
      where: 'resource.attributes["service.name"] == "a" and resource.attributes["b"] == nil',
      by: [],
      unexcluded: 0,
    });
  });

  test('counts a resource that differs only in an attribute a filter cannot compare', () => {
    const tags = (v: string): [string, AnyValue] => ['tags', { kind: 'array', values: [str(v)] }];
    const f = explorerFilter([res([svc, tags('x')])], [res([svc, tags('y')])]);
    expect(f.where).toBe('resource.attributes["service.name"] == "a"');
    expect(f.unexcluded).toBe(1);
  });

  test('an origin that nothing can tell apart gives no where, and every other such resource is unexcluded', () => {
    const tags = (v: string): [string, AnyValue] => ['tags', { kind: 'array', values: [str(v)] }];
    const f = explorerFilter([res([tags('x')])], [res([tags('y')]), res([tags('z')])]);
    expect(f.where).toBeNull();
    expect(f.unexcluded).toBe(2);
    // One with an extra attribute is excluded by it instead.
    const g = explorerFilter([res([tags('x')])], [res([svc, tags('y')])]);
    expect(g.where).toBe('resource.attributes["service.name"] == nil');
    expect(g.unexcluded).toBe(0);
  });

  test('a resource slipping through two origin clauses is counted once', () => {
    const tags = (v: string): [string, AnyValue] => ['tags', { kind: 'array', values: [str(v)] }];
    const other = res([svc, tags('y')]);
    const f = explorerFilter([res([svc, tags('x')]), res([svc, tags('w')])], [other]);
    expect(f.unexcluded).toBe(1);
  });

  test('two origin resources are or-ed and drawn one line each', () => {
    const b = res([['service.name', str('b')]]);
    const f = explorerFilter([res([svc]), b], []);
    expect(f.where).toBe(
      '(resource.attributes["service.name"] == "a") or (resource.attributes["service.name"] == "b")',
    );
    expect(f.by).toEqual(['resource.attributes["service.name"]']);
  });
});
