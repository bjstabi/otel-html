import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { literal, Query, sql } from '@uwdata/mosaic-sql';
import { afterEach, describe, expect, test } from 'vitest';
import { openTestDb } from '../../test-support/duckdb-node.js';
import { ROW_GROUP_ROWS } from '../../test-support/scaling/cost.js';
import { openCountingEngine } from '../../test-support/scaling/counting-engine.js';
import {
  BASE,
  buildScalingReport,
  CROSS,
  type ScalingReport,
  type Shape,
  stepsOf,
} from '../../test-support/scaling/generator.js';

const widthNs = (r: ScalingReport): bigint => BigInt(r.window.end) - BigInt(r.window.start);

async function hashes(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const p = join(rel, e.name);
      if (e.isDirectory()) await walk(p);
      else
        out.set(
          p,
          createHash('sha256')
            .update(await readFile(join(dir, p)))
            .digest('hex'),
        );
    }
  };
  await walk('.');
  return out;
}

/** Row groups of each partition's spans file, read with plain DuckDB over the report folder. */
async function rowGroupsPerPartition(r: ScalingReport): Promise<number[]> {
  const db = await openTestDb();
  try {
    const out: number[] = [];
    for (const p of r.manifest.partitions) {
      const path = p.files.spans?.path;
      if (path === undefined) throw new Error('no spans file');
      db.registerFile(path, new Uint8Array(await readFile(join(r.dir, path))));
      const [row] = db.rows(`SELECT count(DISTINCT row_group_id) AS g FROM parquet_metadata('${path}')`);
      out.push(Number((row as { g: unknown } | undefined)?.g));
    }
    return out;
  } finally {
    db.close();
  }
}

describe('the scaling report generator', { timeout: 120_000 }, () => {
  const opened: ScalingReport[] = [];
  const build = async (shape: Shape): Promise<ScalingReport> => {
    const r = await buildScalingReport(shape);
    opened.push(r);
    return r;
  };
  afterEach(async () => {
    for (const r of opened.splice(0)) await r.close();
  });

  test('the same shape gives byte-identical files', async () => {
    const shape = stepsOf('density', 'dense')[0] ?? BASE;
    const a = await buildScalingReport(shape);
    const first = await hashes(a.dir);
    await a.close();
    const b = await buildScalingReport(shape);
    opened.push(b);
    expect(await hashes(b.dir)).toEqual(first);
    expect(first.size).toBeGreaterThan(3);
  });

  test('a partition has the row groups its shape asks for', async () => {
    expect(await rowGroupsPerPartition(await build(BASE))).toEqual([2, 2, 2, 2]);
    expect(await rowGroupsPerPartition(await build({ ...BASE, rowGroups: 8 }))).toEqual([8, 8, 8, 8]);
    expect(CROSS.rowGroups).toBe(4);
    expect(ROW_GROUP_ROWS).toBeGreaterThan(0);
  });

  test('dense windows are short and sparse windows are long', async () => {
    expect(widthNs(await build({ ...BASE, inside: 8 }))).toBeLessThan(16_777_216_000_000n);
    expect(widthNs(await build({ ...BASE, spacing: 'sparse' }))).toBeGreaterThanOrEqual(16_777_216_000_000n);
  });

  test('each partition records run.id in its statistics', async () => {
    const r = await build(BASE);
    expect(r.manifest.partitions.map((p) => p.files.spans?.values['resource:run.id'])).toEqual([
      ['run-0'],
      ['run-1'],
      ['run-2'],
      ['run-3'],
    ]);
  });

  test('ids name rows that exist', async () => {
    const r = await build(BASE);
    const c = await openCountingEngine(r.dir, r.manifest);
    try {
      const count = async (table: string, where: ReturnType<typeof sql>): Promise<number> => {
        const t = await c.engine.query(Query.from(table).select({ n: sql`count(*)` }).where(where));
        return Number((t.toArray()[0] as { n: unknown } | undefined)?.n);
      };
      const { ids } = r;
      const like = (column: string, v: string) => sql`cast(${column} as varchar) LIKE ${literal(`%${v}%`)}`;
      expect(await count('spans', sql`trace_id = ${literal(ids.traceId)}`)).toBeGreaterThan(0);
      expect(await count('spans', sql`span_id = ${literal(ids.spanId)}`)).toBeGreaterThan(0);
      expect(await count('spans', sql`service_name = ${literal(ids.service)}`)).toBeGreaterThan(0);
      expect(await count('spans', sql`resource_name = ${literal(ids.resource)}`)).toBeGreaterThan(0);
      expect(await count('spans', like('resource_attributes', ids.runId))).toBeGreaterThan(0);
      expect(await count('spans', like('attributes', ids.route))).toBeGreaterThan(0);
      expect(await count('logs', like('body', ids.text))).toBeGreaterThan(0);
      expect(await count('points', sql`metric_name = ${literal(ids.metric)}`)).toBeGreaterThan(0);
      const [n, i] = ids.logRef.split('.').map(Number);
      expect(r.manifest.partitions.some((p) => p.n === n)).toBe(true);
      expect(i).toBeGreaterThanOrEqual(0);
    } finally {
      await c.close();
    }
  });
});
