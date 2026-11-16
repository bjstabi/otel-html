import { afterEach, describe, expect, test } from 'vitest';
import { buildFormat4Report, spansOnlyRequest } from '../../test-support/format4-fixture.js';
import { writeReportDir } from '../../test-support/report-dir.js';
import { openCountingEngine } from '../../test-support/scaling/counting-engine.js';
import {
  isResidualLimit,
  LAYOUT_STATEMENTS,
  type LayoutContext,
  measureStatement,
  tablesOf,
} from '../../test-support/scaling/layout-statements.js';
import type { Live } from '../../test-support/scaling/measure.js';

describe('the layout statements', { timeout: 60_000 }, () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });

  async function open(): Promise<{ live: Live; ctx: LayoutContext }> {
    const report = await buildFormat4Report([spansOnlyRequest(40), spansOnlyRequest(40)], { close: false });
    const dir = await writeReportDir(report);
    closers.push(dir.close);
    const counting = await openCountingEngine(dir.dir, report.manifest);
    closers.push(counting.close);
    const sizes = new Map<string, number>();
    for (const p of report.manifest.partitions)
      for (const f of Object.values(p.files)) sizes.set(f.path, f.bytes);
    const newest = String(Math.max(...report.manifest.partitions.map((p) => p.n))).padStart(6, '0');
    const live = { report: { manifest: report.manifest, ids: {} }, counting, sizes, turn: Promise.resolve() };
    return { live: live as unknown as Live, ctx: { newest } as LayoutContext };
  }

  const statement = (id: string) => {
    const s = LAYOUT_STATEMENTS.find((x) => x.id === id);
    if (s === undefined) throw new Error(id);
    return s;
  };

  test('the newest-partition predicate matches the manifest-relative filename', async () => {
    const { live, ctx } = await open();
    const text = `SELECT count(*) AS n FROM spans WHERE ${statement('spans.newest').sql(live.report.ids, ctx).split(' WHERE ')[1]?.split(' ORDER BY')[0]}`;
    const table = await live.counting.engine.query(text as never);
    expect(Number((table.toArray()[0] as { n: bigint }).n)).toBe(40);
  });

  test('a statement prepares the small files of its tables by default, and reads them by range with prepare off', async () => {
    const { live, ctx } = await open();
    const prepared = await measureStatement(live, statement('spans.newest'), ctx);
    const ranged = await measureStatement(live, statement('spans.newest'), ctx, { prepare: false });
    expect(prepared.cost.serial).toBeLessThan(ranged.cost.serial);
    expect(prepared.small).toBe(0);
    expect(ranged.small).toBeGreaterThan(0);
  });

  test('tablesOf names the views a statement reads', () => {
    expect(tablesOf('SELECT * FROM spans JOIN traces ON 1 WHERE x')).toEqual(['spans', 'traces']);
    expect(tablesOf('SELECT 1')).toEqual([]);
  });

  test('only a residual entry past the candidate limit is the expected failure', () => {
    const limit = new Error(
      'the condition needs the browser to evaluate part of it on more than 200000 rows; narrow the window',
    );
    expect(isResidualLimit('spans.total.residual.long', limit)).toBe(true);
    expect(isResidualLimit('spans.total', limit)).toBe(false);
    expect(isResidualLimit('spans.total.residual.long', new Error('timed out'))).toBe(false);
  });
});
