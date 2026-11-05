import { OtelHtmlError } from '../../model/errors.js';

/** The caps a filtered set's facets are rebuilt with: the report's own, as the writer serialized them. */
export interface FacetCaps {
  readonly facetValueCap: number;
  readonly facetKeyCap: number;
}

/** Fallback for callers without a report (the writer's defaults). */
export const DEFAULT_FACET_CAPS: FacetCaps = { facetValueCap: 1_000, facetKeyCap: 500 };

/** The caps a loaded rollup's facets were written with. */
export function capsOf(rollups: {
  readonly facets: { readonly valueCap: number; readonly keyCap: number };
}): FacetCaps {
  return { facetValueCap: rollups.facets.valueCap, facetKeyCap: rollups.facets.keyCap };
}

const ABORT_CHECK_EVERY = 4096;

/** Queries reject with a `DOMException` named `AbortError` (the platform's own abort convention). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('The query was aborted', 'AbortError');
}

/** Counts visited entries and checks the abort signal every `ABORT_CHECK_EVERY` of them. */
export class AbortTicker {
  readonly #signal: AbortSignal | undefined;
  #visited = 0;

  constructor(signal: AbortSignal | undefined) {
    this.#signal = signal;
  }

  tick(): void {
    if (++this.#visited % ABORT_CHECK_EVERY === 0) throwIfAborted(this.#signal);
  }
}

export function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new OtelHtmlError('usage', {
      path: 'query.limit',
      expected: 'a non-negative integer',
      actual: String(limit),
    });
  }
}

export const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

/** The comparator for a sort column: a table lookup that fails fast on an unknown column. */
export function sortFor<T>(table: Readonly<Record<string, T>>, column: string, mode: string): T {
  const fn = Object.hasOwn(table, column) ? table[column] : undefined;
  if (fn === undefined) {
    throw new OtelHtmlError('usage', {
      path: 'query.sort.column',
      expected: `one of ${Object.keys(table).join(', ')} (mode ${mode})`,
      actual: JSON.stringify(column),
    });
  }
  return fn;
}

/** `compare` in the requested direction; ties fall to `tiebreak`, which does not flip with the direction. */
export function ordered<T>(
  dir: 'asc' | 'desc',
  compare: (a: T, b: T) => number,
  tiebreak: (a: T, b: T) => number,
): (a: T, b: T) => number {
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => sign * compare(a, b) || tiebreak(a, b);
}
