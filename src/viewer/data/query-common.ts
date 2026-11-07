/** The caps a filtered set's facets are built with: format 4 uses `DEFAULT_FACET_CAPS` (the manifest records no writer caps and facets are computed at view time); the old chunk readers take the caps the writer serialized. */
export interface FacetCaps {
  readonly facetValueCap: number;
  readonly facetKeyCap: number;
}

/** Fallback for callers without a report (the writer's defaults). */
export const DEFAULT_FACET_CAPS: FacetCaps = { facetValueCap: 1_000, facetKeyCap: 500 };

/** Queries reject with a `DOMException` named `AbortError` (the platform's own abort convention). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('The query was aborted', 'AbortError');
}

export const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);
