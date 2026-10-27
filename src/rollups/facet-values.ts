import type { AnyValue, Attributes } from '../model/anyvalue.js';
import { anyValueToDisplay } from '../model/anyvalue.js';
import type { FacetCounts } from './facets.js';

/** Facet values are truncated to this many UTF-16 units. */
export const MAX_FACET_VALUE_LENGTH = 256;

export function truncateFacetValue(v: string): string {
  return v.length > MAX_FACET_VALUE_LENGTH ? v.slice(0, MAX_FACET_VALUE_LENGTH) : v;
}

type ScalarKind = 'string' | 'int' | 'double' | 'bool';

/** Scalar attributes only (no array, kvlist, bytes or empty), skipping the `skip` keys. */
export function* facetableAttributes(
  attributes: Attributes,
  skip: ReadonlySet<string>,
): Generator<{ key: string; value: string; kind: ScalarKind }> {
  for (const [key, v] of attributes) {
    if (skip.has(key)) continue;
    const kind = scalarKind(v);
    if (kind !== undefined) yield { key, value: anyValueToDisplay(v), kind };
  }
}

function scalarKind(v: AnyValue): ScalarKind | undefined {
  switch (v.kind) {
    case 'string':
    case 'int':
    case 'double':
    case 'bool':
      return v.kind;
    default:
      return undefined;
  }
}

/** Add one (truncated) value to a facet. */
export function addFacet(facets: FacetCounts, key: string, value: string, kind: ScalarKind = 'string'): void {
  facets.add(key, truncateFacetValue(value), kind);
}
