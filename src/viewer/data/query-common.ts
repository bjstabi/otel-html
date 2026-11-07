import { OtelHtmlError } from '../../model/errors.js';

/** The caps a filtered set's facets are built with: format 4 uses `DEFAULT_FACET_CAPS` (the manifest records no writer caps and facets are computed at view time); the old chunk readers take the caps the writer serialized. */
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

/** Entries an in-memory scan visits between yields to the event loop. */
export const EAGER_BLOCK = 8192;

/** Resolve on a later task, so events queued meanwhile (a keystroke's cleanup, an abort) run first. */
export function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const { port1, port2 } = new MessageChannel();
    port1.addEventListener('message', () => {
      port1.close();
      resolve();
    });
    port1.start();
    port2.postMessage(null);
  });
}

/** Visit `entries` in blocks of `EAGER_BLOCK`, yielding to events and checking the signal between blocks. */
export async function visitInBlocks<E>(
  entries: readonly E[],
  run: { visit(e: E): void },
  signal: AbortSignal | undefined,
): Promise<void> {
  for (let start = 0; start < entries.length; start += EAGER_BLOCK) {
    const end = Math.min(start + EAGER_BLOCK, entries.length);
    for (let i = start; i < end; i++) run.visit(entries[i] as E);
    if (end < entries.length) {
      await yieldToEvents();
      throwIfAborted(signal);
    }
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
