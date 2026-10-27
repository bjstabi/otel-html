import { describe, expect, it } from 'vitest';
import { canonicalAttributesKey, Interner } from '../../src/model/interner.js';
import type { ResourceRecord } from '../../src/model/records.js';

const res = (v: string, schemaUrl = ''): ResourceRecord => ({
  attributes: new Map([['service.name', { kind: 'string', value: v }]]),
  droppedAttributesCount: 0,
  schemaUrl,
});
const keyOf = (r: ResourceRecord): string =>
  `${canonicalAttributesKey(r.attributes)}|${r.droppedAttributesCount}|${r.schemaUrl}`;

describe('Interner', () => {
  it('returns the same ref for equal values and different refs otherwise', () => {
    const i = new Interner<ResourceRecord>(keyOf);
    const a = i.intern(res('a'));
    expect(i.intern(res('a'))).toBe(a);
    const b = i.intern(res('b'));
    expect(b).not.toBe(a);
    expect(i.get(b).attributes.get('service.name')).toEqual({ kind: 'string', value: 'b' });
    expect(i.entries()).toHaveLength(2);
  });
  it('throws on unknown ref', () => {
    expect(() => new Interner<string>((s) => s).get(0)).toThrow();
  });
});
