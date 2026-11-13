/**
 * Duration buckets of the span rollups: eight per power of two (`log2x8`), by integer arithmetic only, so SQL and
 * TypeScript agree to the last value. A duration d > 0 with e = bitLength(d) - 1 is shifted to x = d << (62 - e), in
 * [2^62, 2^63), and its bucket is 8e plus the number of thresholds at or below x.
 */

/** floor(2^(62 + j/8)) for j = 1…7. */
const DURATION_THRESHOLDS = [
  5029079263719320435n,
  5484249825272419511n,
  5980616842327661685n,
  6521908912666391106n,
  7112192101001162094n,
  7755900482342532474n,
  8457869449776733335n,
] as const;

/** The bucket of a duration: -1 for a duration of zero or less. */
export function durationBucket(durationNs: bigint): number {
  if (durationNs <= 0n) return -1;
  const e = durationNs.toString(2).length - 1;
  const x = durationNs << BigInt(62 - e);
  let j = 0;
  for (const t of DURATION_THRESHOLDS) if (x >= t) j++;
  return 8 * e + j;
}

/** A bucket's representative duration, 2^((bucket + 0.5) / 8); 0 for bucket -1. */
export function bucketValue(bucket: number): number {
  return bucket < 0 ? 0 : 2 ** ((bucket + 0.5) / 8);
}

/** The same rule as `durationBucket` over a BIGINT column or expression. */
export function durationBucketSql(column: string): string {
  const e = `(length(bin(${column})) - 1)`;
  const x = `(${column} << (62 - ${e}))`;
  const count = DURATION_THRESHOLDS.map((t) => `CASE WHEN ${x} >= ${t} THEN 1 ELSE 0 END`).join(' + ');
  return `CASE WHEN ${column} <= 0 THEN -1 ELSE CAST(8 * ${e} + ${count} AS INTEGER) END`;
}
