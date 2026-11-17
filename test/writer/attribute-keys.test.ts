import { describe, expect, test } from 'vitest';
import { attributesToJson } from '../../src/format/columns.js';
import type { AnyValue, Attributes } from '../../src/model/anyvalue.js';
import { AttributeKeyCounts, MAX_ATTRIBUTE_KEYS } from '../../src/writer/attribute-keys.js';

const rows = (): Attributes[] => {
  const kv = new Map<string, AnyValue>([['inner', { kind: 'string', value: 'x' }]]);
  return [
    new Map<string, AnyValue>([
      ['s', { kind: 'string', value: 'a' }],
      ['i', { kind: 'int', value: 3n }],
      ['big', { kind: 'int', value: 2n ** 60n }],
      ['d', { kind: 'double', value: 1.5 }],
      ['whole', { kind: 'double', value: 2 }],
      ['nan', { kind: 'double', value: Number.NaN }],
      ['b', { kind: 'bool', value: false }],
      ['empty', { kind: 'empty' }],
      ['blank', { kind: 'string', value: '' }],
      ['bytes', { kind: 'bytes', value: new Uint8Array([1]) }],
      ['arr', { kind: 'array', values: [{ kind: 'string', value: 'x' }] }],
      ['map', { kind: 'kvlist', values: kv }],
    ]),
    new Map<string, AnyValue>([
      ['s', { kind: 'int', value: 4n }],
      ['$weird', { kind: 'string', value: 'v' }],
      ['i', { kind: 'empty' }],
    ]),
    new Map(),
  ];
};

describe('AttributeKeyCounts', () => {
  test('counts scalar entries of every kind, and not null, array, nested or bytes values', () => {
    const c = new AttributeKeyCounts();
    for (const a of rows()) c.addAttributes(a);
    expect(c.record()).toEqual({
      $weird: 1,
      b: 1,
      big: 1,
      blank: 1,
      d: 1,
      i: 1,
      nan: 1,
      s: 2,
      whole: 1,
    });
  });

  test('the stored JSON text counts the same as the records', () => {
    const a = new AttributeKeyCounts();
    const b = new AttributeKeyCounts();
    for (const r of rows()) {
      a.addAttributes(r);
      b.addJson(attributesToJson(r));
    }
    expect(b.record()).toEqual(a.record());
  });

  test('a record sums with another', () => {
    const c = new AttributeKeyCounts();
    c.addRecord({ a: 2, b: 1 });
    c.addRecord({ a: 3 });
    expect(c.record()).toEqual({ a: 5, b: 1 });
  });

  test('more than the limit of distinct keys records nothing, exactly the limit records all', () => {
    const at = (n: number): AttributeKeyCounts => {
      const c = new AttributeKeyCounts();
      c.addAttributes(
        new Map(
          Array.from({ length: n }, (_, i): [string, AnyValue] => [`k${i}`, { kind: 'bool', value: true }]),
        ),
      );
      return c;
    };
    expect(MAX_ATTRIBUTE_KEYS).toBe(1000);
    expect(Object.keys(at(1000).record() ?? {})).toHaveLength(1000);
    expect(at(1001).record()).toBeUndefined();
  });
});
