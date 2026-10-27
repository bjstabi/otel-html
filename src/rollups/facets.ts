import { z } from 'zod';
import { parseWith } from '../format/validate.js';

/** Value type of a facet key: what OTTL literal a filter on it needs. `mixed` means more than one type was seen. */
export type FacetKind = 'string' | 'int' | 'double' | 'bool' | 'mixed';

const FacetKindSchema = z.enum(['string', 'int', 'double', 'bool', 'mixed']);

export type SerializedFacets = {
  valueCap: number;
  keyCap: number;
  pinned: string[];
  skippedKeyAdds: number;
  keys: { key: string; kind: FacetKind; total: number; other: number; values: [string, number][] }[];
};

const nonNegInt: z.ZodNumber = z.number().int().nonnegative();

const SerializedFacetsSchema: z.ZodType<SerializedFacets> = z.strictObject({
  valueCap: nonNegInt,
  keyCap: nonNegInt,
  pinned: z.array(z.string()),
  skippedKeyAdds: nonNegInt,
  keys: z.array(
    z
      .strictObject({
        key: z.string(),
        kind: FacetKindSchema,
        total: nonNegInt,
        other: nonNegInt,
        values: z.array(z.tuple([z.string(), nonNegInt])),
      })
      .refine((k) => k.values.reduce((s, [, n]) => s + n, k.other) === k.total, {
        message: 'total equal to other + sum(values)',
        path: ['total'],
      }),
  ),
});

interface KeyState {
  kind: FacetKind;
  total: number;
  other: number;
  values: Map<string, number>;
}

/**
 * Value counts per facet key. Each key tracks at most `valueCap` distinct values (first seen wins);
 * observations of any further value are tallied exactly in `other`. At most `keyCap` unpinned keys
 * are tracked; adds for keys beyond that are counted in `skippedKeyAdds`.
 */
export class FacetCounts {
  readonly valueCap: number;
  readonly keyCap: number;
  readonly pinned: ReadonlySet<string>;
  skippedKeyAdds = 0;
  readonly #keys = new Map<string, KeyState>();
  #unpinned = 0;

  constructor(valueCap: number, keyCap: number, pinned: readonly string[] = []) {
    this.valueCap = valueCap;
    this.keyCap = keyCap;
    this.pinned = new Set(pinned);
  }

  add(key: string, value: string, kind: Exclude<FacetKind, 'mixed'> = 'string'): void {
    let st = this.#keys.get(key);
    if (st === undefined) {
      const pinned = this.pinned.has(key);
      if (!pinned && this.#unpinned >= this.keyCap) {
        this.skippedKeyAdds++;
        return;
      }
      if (!pinned) this.#unpinned++;
      st = { kind, total: 0, other: 0, values: new Map() };
      this.#keys.set(key, st);
    }
    if (st.kind !== kind) st.kind = 'mixed';
    st.total++;
    const n = st.values.get(value);
    if (n !== undefined) st.values.set(value, n + 1);
    else if (st.values.size < this.valueCap) st.values.set(value, 1);
    else st.other++;
  }

  /** Most frequent tracked values: count descending, then value ascending. */
  top(key: string, n: number): { value: string; count: number }[] {
    const st = this.#keys.get(key);
    if (st === undefined) return [];
    return [...st.values]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
      .slice(0, n);
  }

  /** Value type of the key's observations; undefined for an untracked key. */
  kind(key: string): FacetKind | undefined {
    return this.#keys.get(key)?.kind;
  }

  /** Observations whose value is not tracked (exact). */
  other(key: string): number {
    return this.#keys.get(key)?.other ?? 0;
  }

  /** All observations for the key. */
  total(key: string): number {
    return this.#keys.get(key)?.total ?? 0;
  }

  keys(): string[] {
    return [...this.#keys.keys()];
  }

  toJSON(): SerializedFacets {
    return {
      valueCap: this.valueCap,
      keyCap: this.keyCap,
      pinned: [...this.pinned],
      skippedKeyAdds: this.skippedKeyAdds,
      keys: [...this.#keys].map(([key, st]) => ({
        key,
        kind: st.kind,
        total: st.total,
        other: st.other,
        values: [...st.values],
      })),
    };
  }

  /** Rebuild from JSON. `caps` override the stored caps for future adds (stored data is kept as-is). */
  static from(input: unknown, root = 'facets', caps?: { valueCap: number; keyCap: number }): FacetCounts {
    const s = parseWith(SerializedFacetsSchema, input, root);
    const f = new FacetCounts(caps?.valueCap ?? s.valueCap, caps?.keyCap ?? s.keyCap, s.pinned);
    f.skippedKeyAdds = s.skippedKeyAdds;
    for (const k of s.keys) {
      f.#keys.set(k.key, { kind: k.kind, total: k.total, other: k.other, values: new Map(k.values) });
      if (!f.pinned.has(k.key)) f.#unpinned++;
    }
    return f;
  }
}
