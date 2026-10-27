import type { AnyValue, Attributes } from './anyvalue.js';

export class Interner<T> {
  readonly #keyOf: (t: T) => string;
  readonly #refs = new Map<string, number>();
  readonly #items: T[] = [];

  constructor(keyOf: (t: T) => string) {
    this.#keyOf = keyOf;
  }

  intern(t: T): number {
    const key = this.#keyOf(t);
    const existing = this.#refs.get(key);
    if (existing !== undefined) return existing;
    const ref = this.#items.length;
    this.#items.push(t);
    this.#refs.set(key, ref);
    return ref;
  }

  get(ref: number): T {
    const item = this.#items[ref];
    if (item === undefined) throw new RangeError(`unknown interner ref ${ref}`);
    return item;
  }

  entries(): readonly T[] {
    return this.#items;
  }
}

function valueKey(v: AnyValue): string {
  switch (v.kind) {
    case 'string':
      return `s${JSON.stringify(v.value)}`;
    case 'bool':
      return `b${v.value}`;
    case 'int':
      return `i${v.value}`;
    case 'double':
      return `d${Object.is(v.value, -0) ? '-0' : v.value}`;
    case 'bytes':
      return `x${Array.from(v.value, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    case 'array':
      return `[${v.values.map(valueKey).join(',')}]`;
    case 'kvlist':
      return `{${canonicalAttributesKey(v.values)}}`;
    case 'empty':
      return 'e';
  }
}

export function canonicalAttributesKey(a: Attributes): string {
  return [...a.keys()]
    .sort()
    .map((k) => `${JSON.stringify(k)}=${valueKey(a.get(k) ?? { kind: 'empty' })}`)
    .join(';');
}
