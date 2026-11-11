/**
 * Splitting a list of test files into shards by recorded duration. Free of vitest and Node imports: both
 * `vitest.config.ts` (through the sequencer) and `playwright.config.ts` load it.
 */

/** A recorded duration per file, in seconds. */
export type Weights = Readonly<Record<string, number>>;

/** `"i/n"` as numbers: `index` is 1-based, `1 <= index <= count`. */
export interface ShardSpec {
  index: number;
  count: number;
}

/** Parse `i/n` (as in `--shard=1/2`). Throws on anything else, or an index outside 1..n. */
export function parseShard(raw: string): ShardSpec {
  const m = /^(\d+)\/(\d+)$/.exec(raw);
  const index = m ? Number(m[1]) : 0;
  const count = m ? Number(m[2]) : 0;
  if (index < 1 || count < 1 || index > count) {
    throw new Error(`shard must be i/n with 1 <= i <= n, got ${raw}`);
  }
  return { index, count };
}

/**
 * Greedy longest-first: items by weight descending (then key ascending), each into the bin with the least weight so far
 * (the lowest index on a tie). Deterministic; every key lands in exactly one bin, and a bin may be empty.
 */
export function partition(items: readonly { key: string; weight: number }[], count: number): string[][] {
  const bins: string[][] = Array.from({ length: count }, () => []);
  const sums: number[] = Array.from({ length: count }, () => 0);
  const sorted = [...items].sort(
    (a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  for (const { key, weight } of sorted) {
    let best = 0;
    for (let i = 1; i < count; i++) if ((sums[i] ?? 0) < (sums[best] ?? 0)) best = i;
    bins[best]?.push(key);
    sums[best] = (sums[best] ?? 0) + weight;
  }
  return bins;
}

/** The median of the table's weights, 1 when it is empty. What a file missing from the table weighs. */
export function medianWeight(weights: Weights): number {
  const v = Object.values(weights).sort((a, b) => a - b);
  if (v.length === 0) return 1;
  const mid = v.length >> 1;
  return v.length % 2 ? (v[mid] ?? 1) : ((v[mid - 1] ?? 1) + (v[mid] ?? 1)) / 2;
}

/** The keys of shard `index` (1-based) of `count`, in the order `partition` assigned them. */
export function shardOf(keys: readonly string[], weights: Weights, index: number, count: number): string[] {
  const fallback = medianWeight(weights);
  const items = keys.map((key) => ({ key, weight: weights[key] ?? fallback }));
  return partition(items, count)[index - 1] ?? [];
}
