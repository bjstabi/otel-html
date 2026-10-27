import { describe, expect, it } from 'vitest';
import { type AnyValue, anyValueEquals, anyValueToDisplay } from '../../src/model/anyvalue.js';
import { canonicalAttributesKey } from '../../src/model/interner.js';

describe('anyValueToDisplay', () => {
  it('renders kvlist as JSON', () => {
    const v: AnyValue = { kind: 'kvlist', values: new Map([['a', { kind: 'int', value: 1n }]]) };
    expect(anyValueToDisplay(v)).toBe('{"a":1}');
  });
  it('renders bytes as base64', () => {
    expect(anyValueToDisplay({ kind: 'bytes', value: new Uint8Array([1, 2]) })).toBe('AQI=');
  });
  it('renders scalars and arrays', () => {
    expect(anyValueToDisplay({ kind: 'string', value: 'x' })).toBe('x');
    expect(anyValueToDisplay({ kind: 'bool', value: true })).toBe('true');
    expect(anyValueToDisplay({ kind: 'double', value: 1.5 })).toBe('1.5');
    expect(anyValueToDisplay({ kind: 'empty' })).toBe('');
    expect(
      anyValueToDisplay({
        kind: 'array',
        values: [
          { kind: 'string', value: 's' },
          { kind: 'int', value: 2n },
        ],
      }),
    ).toBe('["s",2]');
  });
});

describe('anyValueEquals', () => {
  it('compares structurally', () => {
    const a: AnyValue = { kind: 'array', values: [{ kind: 'bytes', value: new Uint8Array([1]) }] };
    const b: AnyValue = { kind: 'array', values: [{ kind: 'bytes', value: new Uint8Array([1]) }] };
    expect(anyValueEquals(a, b)).toBe(true);
    expect(anyValueEquals(a, { kind: 'empty' })).toBe(false);
    expect(anyValueEquals({ kind: 'int', value: 1n }, { kind: 'double', value: 1 })).toBe(false);
  });
});

describe('canonicalAttributesKey', () => {
  it('is insertion-order independent', () => {
    const x = { kind: 'string', value: 'v' } as const;
    const y = { kind: 'int', value: 3n } as const;
    const m1 = new Map<string, AnyValue>([
      ['a', x],
      ['b', y],
    ]);
    const m2 = new Map<string, AnyValue>([
      ['b', y],
      ['a', x],
    ]);
    expect(canonicalAttributesKey(m1)).toBe(canonicalAttributesKey(m2));
    expect(canonicalAttributesKey(m1)).not.toBe(canonicalAttributesKey(new Map([['a', x]])));
  });
});

describe('edge cases', () => {
  const big = 9007199254740993n;
  it('keeps ints beyond 2^53 exact in display and JSON', () => {
    expect(anyValueToDisplay({ kind: 'int', value: big })).toBe('9007199254740993');
    expect(anyValueToDisplay({ kind: 'array', values: [{ kind: 'int', value: big }] })).toBe(
      '["9007199254740993"]',
    );
    expect(
      anyValueToDisplay({ kind: 'kvlist', values: new Map([['n', { kind: 'int', value: -big }]]) }),
    ).toBe('{"n":"-9007199254740993"}');
  });
  it('renders nested kvlist/array with bytes', () => {
    const v: AnyValue = {
      kind: 'kvlist',
      values: new Map<string, AnyValue>([
        ['b', { kind: 'bytes', value: new Uint8Array([1, 2, 3]) }],
        [
          'arr',
          {
            kind: 'array',
            values: [
              { kind: 'bytes', value: new Uint8Array([255]) },
              { kind: 'kvlist', values: new Map() },
            ],
          },
        ],
      ]),
    };
    expect(anyValueToDisplay(v)).toBe('{"b":"AQID","arr":["/w==",{}]}');
  });
  it('renders empty array and kvlist', () => {
    expect(anyValueToDisplay({ kind: 'array', values: [] })).toBe('[]');
    expect(anyValueToDisplay({ kind: 'kvlist', values: new Map() })).toBe('{}');
    expect(anyValueEquals({ kind: 'array', values: [] }, { kind: 'array', values: [] })).toBe(true);
    expect(anyValueEquals({ kind: 'array', values: [] }, { kind: 'kvlist', values: new Map() })).toBe(false);
  });
  it('canonicalAttributesKey distinguishes int 1, string "1" and double 1', () => {
    const keys = [
      canonicalAttributesKey(new Map<string, AnyValue>([['k', { kind: 'int', value: 1n }]])),
      canonicalAttributesKey(new Map<string, AnyValue>([['k', { kind: 'string', value: '1' }]])),
      canonicalAttributesKey(new Map<string, AnyValue>([['k', { kind: 'double', value: 1 }]])),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});
