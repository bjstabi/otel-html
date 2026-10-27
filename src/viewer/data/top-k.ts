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
