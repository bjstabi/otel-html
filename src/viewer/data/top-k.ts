/**
 * The first `k` items of a stable sort by `cmp`, without sorting the rest: a quickselect partitions the `k` smallest
 * to the front, then only those are sorted. Ties are broken by input position, so the result equals
 * `[...items].sort(cmp).slice(0, k)`. Result lists show at most `limit` rows of a 100k-span match, and a full sort
 * spends most of its comparisons ordering rows nobody sees.
 */
export function topK<T>(items: readonly T[], k: number, cmp: (a: T, b: T) => number): T[] {
  const n = items.length;
  if (k <= 0) return [];
  if (k >= n) return [...items].sort(cmp);
  // Indexes make the order total (no two elements compare equal), which quickselect needs to stay deterministic.
  const order = (i: number, j: number): number => cmp(items[i] as T, items[j] as T) || i - j;
  const idx = Array.from({ length: n }, (_, i) => i);
  const swap = (a: number, b: number): void => {
    const t = idx[a] as number;
    idx[a] = idx[b] as number;
    idx[b] = t;
  };
  let lo = 0;
  let hi = n - 1;
  const target = k - 1;
  while (hi > lo) {
    // Median of three keeps ordered and reverse-ordered input (common for time columns) linear.
    const mid = (lo + hi) >>> 1;
    if (order(idx[mid] as number, idx[lo] as number) < 0) swap(lo, mid);
    if (order(idx[hi] as number, idx[lo] as number) < 0) swap(lo, hi);
    if (order(idx[hi] as number, idx[mid] as number) < 0) swap(mid, hi);
    const pivot = idx[mid] as number;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (order(idx[i] as number, pivot) < 0) i++;
      while (order(idx[j] as number, pivot) > 0) j--;
      if (i <= j) {
        swap(i, j);
        i++;
        j--;
      }
    }
    if (target <= j) hi = j;
    else if (target >= i) lo = i;
    else break;
  }
  return idx
    .slice(0, k)
    .sort(order)
    .map((i) => items[i] as T);
}

/**
 * The best `limit` of a stream of items, held in bounded memory: items pile up until the buffer reaches
 * `limit + max(limit, 1024)`, then `topK` compacts it back to `limit`. The slack amortises the compaction (one
 * quickselect per at least 1024 pushes) while a 10M-row match still holds about a thousand rows. Compaction keeps
 * stable order, so `take()` equals `topK(everythingPushed, limit, compare)`.
 */
export class TopKBuffer<T> {
  readonly #limit: number;
  readonly #compare: (a: T, b: T) => number;
  readonly #bound: number;
  #items: T[] = [];

  constructor(limit: number, compare: (a: T, b: T) => number) {
    this.#limit = limit;
    this.#compare = compare;
    this.#bound = limit + Math.max(limit, 1024);
  }

  push(item: T): void {
    this.#items.push(item);
    if (this.#items.length >= this.#bound) this.#items = topK(this.#items, this.#limit, this.#compare);
  }

  /** How many items are held right now (never more than the bound). */
  get size(): number {
    return this.#items.length;
  }

  /** The best `limit` items pushed so far, in order. */
  take(): T[] {
    return topK(this.#items, this.#limit, this.#compare);
  }
}
