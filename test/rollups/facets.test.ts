import { describe, expect, it } from 'vitest';
import { FacetCounts } from '../../src/rollups/facets.js';

describe('FacetCounts', () => {
  it('caps values and reports an exact other count', () => {
    const f = new FacetCounts(3, 10);
    for (const [v, n] of [
      ['a', 5],
      ['b', 4],
      ['c', 3],
      ['d', 2],
      ['e', 1],
    ] as const) {
      for (let i = 0; i < n; i++) f.add('k', v);
    }
    const top = f.top('k', 3);
    expect(top).toEqual([
      { value: 'a', count: 5 },
      { value: 'b', count: 4 },
      { value: 'c', count: 3 },
    ]);
    expect(f.other('k')).toBe(3);
    expect(top.reduce((s, x) => s + x.count, 0) + f.other('k')).toBe(f.total('k'));
  });
  it('caps keys but never pinned keys', () => {
    const f = new FacetCounts(5, 2, ['core']);
    f.add('x', '1');
    f.add('y', '1');
    f.add('z', '1');
    f.add('core', '1');
    expect(f.keys().sort()).toEqual(['core', 'x', 'y']);
    expect(f.skippedKeyAdds).toBe(1);
    expect(f.top('z', 5)).toEqual([]);
  });
  it('orders ties by value and round-trips', () => {
    const f = new FacetCounts(2, 5, ['p']);
    for (const v of ['b', 'a', 'c', 'c']) f.add('k', v);
    expect(f.top('k', 5)).toEqual([
      { value: 'a', count: 1 },
      { value: 'b', count: 1 },
    ]);
    const copy = FacetCounts.from(JSON.parse(JSON.stringify(f.toJSON())));
    expect(copy.toJSON()).toEqual(f.toJSON());
    expect(copy.other('k')).toBe(2);
  });
  it('rejects inconsistent serialized data', () => {
    const f = new FacetCounts(2, 2);
    f.add('k', 'a');
    const j = f.toJSON();
    const first = j.keys[0];
    expect(first).toBeDefined();
    expect(() => FacetCounts.from({ ...j, keys: [{ ...first, total: 99 }] })).toThrow(/total/);
  });
});

describe('FacetCounts kind', () => {
  it('tracks one value type per key, becomes mixed on a second type, and round-trips', () => {
    const f = new FacetCounts(5, 5);
    f.add('a', '1', 'int');
    f.add('a', '2', 'int');
    f.add('b', 'x');
    f.add('c', '1', 'int');
    f.add('c', 'x', 'string');
    expect([f.kind('a'), f.kind('b'), f.kind('c'), f.kind('zz')]).toEqual([
      'int',
      'string',
      'mixed',
      undefined,
    ]);
    const back = FacetCounts.from(JSON.parse(JSON.stringify(f.toJSON())));
    expect([back.kind('a'), back.kind('b'), back.kind('c')]).toEqual(['int', 'string', 'mixed']);
  });
});
