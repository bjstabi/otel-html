import { describe, expect, it } from 'vitest';
import { medianWeight, parseShard, partition, shardOf } from '../../test-support/shard.ts';

describe('parseShard', () => {
  it('reads i/n', () => {
    expect(parseShard('2/3')).toEqual({ index: 2, count: 3 });
  });
  it.each(['', '1', '0/2', '3/2', 'a/b', '1/2/3', '-1/2'])('rejects %j', (raw) => {
    expect(() => parseShard(raw)).toThrow(/i\/n/);
  });
});

describe('partition', () => {
  const items = [
    { key: 'a', weight: 5 },
    { key: 'b', weight: 4 },
    { key: 'c', weight: 3 },
    { key: 'd', weight: 3 },
    { key: 'e', weight: 1 },
  ];
  it('puts each key in exactly one bin, balanced longest-first', () => {
    const bins = partition(items, 2);
    expect(bins).toEqual([
      ['a', 'd'],
      ['b', 'c', 'e'],
    ]);
    expect(bins.flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('is independent of input order and breaks ties by key', () => {
    expect(partition([...items].reverse(), 2)).toEqual(partition(items, 2));
  });
  it('returns empty bins when there are fewer items than bins', () => {
    expect(partition([{ key: 'a', weight: 1 }], 3)).toEqual([['a'], [], []]);
  });
});

describe('shardOf', () => {
  it('weighs a key missing from the table as the median', () => {
    expect(medianWeight({ a: 1, b: 3, c: 100 })).toBe(3);
    expect(medianWeight({ a: 1, b: 3 })).toBe(2);
    expect(medianWeight({})).toBe(1);
    // z weighs the median (5), so it is placed before the weight-4 file and splits from the weight-10 one.
    expect(shardOf(['x', 'y', 'z'], { x: 10, y: 4, w: 5 }, 1, 2)).toEqual(['x']);
    expect(shardOf(['x', 'y', 'z'], { x: 10, y: 4, w: 5 }, 2, 2)).toEqual(['z', 'y']);
  });
  it('splits the shards into a partition of the keys', () => {
    const keys = ['a', 'b', 'c', 'd'];
    const w = { a: 1, b: 2, c: 3, d: 4 };
    const all = [...shardOf(keys, w, 1, 3), ...shardOf(keys, w, 2, 3), ...shardOf(keys, w, 3, 3)];
    expect(all.sort()).toEqual(keys);
  });
});
