import { afterAll, beforeAll, expect, test } from 'vitest';
import { parseTraceId } from '../../src/model/ids.js';
import { traceBoundOf, tracePartitionsBatchQuery, traceSpansBatchQuery } from '../../src/query/sql/spans.js';
import { filesFor, runPrepared } from '../../src/viewer/data/query-common.js';
import { cell, rowsOf } from '../../src/viewer/data/span-results.js';
import {
  type CountingEngine,
  openCountingEngine,
  type ReadEvent,
} from '../../test-support/scaling/counting-engine.js';
import { buildScalingReport, type ScalingReport } from '../../test-support/scaling/generator.js';

/**
 * The evidence that the batched span statement prunes row groups by the start statistics: with the traces' bounds it
 * reads far fewer bytes of the spans files than with the same ids and no bounds, and fewer than the files hold. (An OR
 * of per-trace ranges read all 2.7 MB of this report's spans files, the same as no bounds; the one range reads 0.36 MB.)
 */
let report: ScalingReport;
let counting: CountingEngine;

beforeAll(async () => {
  report = await buildScalingReport({ outside: 1, inside: 2, rowGroups: 6, spacing: 'dense' });
  counting = await openCountingEngine(report.dir, report.manifest);
}, 120_000);
afterAll(async () => {
  await counting.close();
  await report.close();
});

const spansBytes = (events: readonly ReadEvent[]): number =>
  events
    .filter((e) => e.kind === 'read' && e.path.endsWith('spans.parquet'))
    .reduce((n, e) => n + e.bytes, 0);

test('the bounded batch reads fewer bytes of the spans files than the unbounded one', async () => {
  const { manifest } = report;
  const ids = report.ids.traceIds.map((t) => parseTraceId(t, 'test'));
  const partitions = rowsOf(
    await runPrepared(counting.engine, tracePartitionsBatchQuery(ids), filesFor(manifest, ['traces'])),
  );
  const bound = (id: string) =>
    traceBoundOf(
      partitions
        .filter((r) => String(cell(r, 'trace_id')) === id)
        .map((r) => ({ min_start: cell(r, 'min_start'), max_end: cell(r, 'max_end') })),
    );
  const files = filesFor(manifest, ['spans']);
  const read = async (bounded: boolean): Promise<{ bytes: number; rows: number }> => {
    await counting.cold();
    await counting.take();
    const q = traceSpansBatchQuery(
      ids.map((traceId) => ({ traceId, bound: bounded ? bound(traceId) : null })),
      files,
      report.epoch,
    );
    const rows = rowsOf(await runPrepared(counting.engine, q, files)).length;
    return { bytes: spansBytes(await counting.take()), rows };
  };
  const withBounds = await read(true);
  const without = await read(false);
  const held = report.manifest.partitions.reduce((n, p) => n + (p.files.spans?.bytes ?? 0), 0);
  expect(withBounds.rows).toBe(without.rows);
  expect(withBounds.rows).toBeGreaterThan(0);
  expect(withBounds.bytes).toBeLessThan(without.bytes / 3);
  expect(withBounds.bytes).toBeLessThan(held / 4);
}, 60_000);
