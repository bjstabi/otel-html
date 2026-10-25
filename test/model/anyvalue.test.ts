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
