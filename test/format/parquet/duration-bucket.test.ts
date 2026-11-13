import { describe, expect, test } from 'vitest';
import {
  bucketValue,
  durationBucket,
  durationBucketSql,
} from '../../../src/format/parquet/duration-bucket.js';
import { openTestDb } from '../../../test-support/duckdb-node.js';

function seeded(n: number): bigint[] {
  let s = 0x2545f491n;
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    const bits = BigInt(1 + Number((s >> 40n) % 62n));
    out.push((s >> 1n) % (1n << bits) || 1n);
  }
  return out;
}

describe('durationBucket', () => {
  test('exact values', () => {
    expect([0n, -5n, 1n, 2n, 3n, 1024n, 1_000_000n].map(durationBucket)).toEqual([-1, -1, 0, 8, 12, 80, 159]);
  });

  test('SQL and TypeScript agree on 2^k, 2^k ± 1 (k = 0…62) and 10,000 seeded values', async () => {
    const values = new Set<bigint>([0n, -1n]);
    for (let k = 0; k <= 62; k++) {
      for (const d of [(1n << BigInt(k)) - 1n, 1n << BigInt(k), (1n << BigInt(k)) + 1n]) {
        if (d < 2n ** 63n) values.add(d);
      }
    }
    for (const d of seeded(10_000)) values.add(d);
    const list = [...values];
    const db = await openTestDb();
    try {
      db.exec(`CREATE TABLE d (v BIGINT)`);
      for (let i = 0; i < list.length; i += 500) {
        db.exec(
          `INSERT INTO d VALUES ${list
            .slice(i, i + 500)
            .map((v) => `(${v})`)
            .join(', ')}`,
        );
      }
      const rows = db.rows(`SELECT v, ${durationBucketSql('v')} AS b FROM d`);
      expect(rows).toHaveLength(list.length);
      for (const r of rows as { v: bigint; b: number }[]) {
        expect([r.v, Number(r.b)]).toEqual([r.v, durationBucket(r.v)]);
      }
    } finally {
      db.close();
    }
  });

  test('bucketValue is within 4.43 % of every duration in its bucket', () => {
    for (const d of seeded(10_000)) {
      expect(Math.abs(bucketValue(durationBucket(d)) / Number(d) - 1)).toBeLessThanOrEqual(0.0443 + 1e-9);
    }
    expect(bucketValue(-1)).toBe(0);
  });
});
