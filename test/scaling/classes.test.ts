import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import {
  type Axis,
  CATALOGUE,
  type CatalogueEntry,
  type CostClass,
  DECLARED,
  KNOWN_DEBT,
  SMALL_TABLE_ENTRIES,
} from '../../src/viewer/data/catalogue.js';
import { LONG_WINDOW_NS } from '../../src/viewer/data/time-window.js';
import { classify, type Step } from '../../test-support/scaling/classify.js';
import { buildScalingReport, type Shape, stepsOf } from '../../test-support/scaling/generator.js';
import { AXES, closeMeasured, measureEntry } from '../../test-support/scaling/measure.js';
import { assertedAxes, fileOf, SPLIT } from '../../test-support/scaling/measured-file.js';
import { ROLLUP_ENTRIES } from '../../test-support/scaling/rollup-entries.js';

const { OTEL_HTML_SCALING: SCALING, OTEL_HTML_SCALING_OUT: OUT } = process.env;

/** The number of lines the known-debt list may hold; a PR that removes lines lowers it. */
const DEBT_MAX = 5;

describe('declared classes', () => {
  test('every catalogue entry has a declaration and nothing else does', () => {
    expect(Object.keys(DECLARED).sort()).toEqual(CATALOGUE.map((e) => e.id).sort());
  });

  test('an axis is null exactly where it does not apply', () => {
    for (const entry of CATALOGUE) {
      expect(DECLARED[entry.id]?.class.window === null, entry.id).toBe(!entry.window);
      expect(DECLARED[entry.id]?.class.retention, entry.id).not.toBeNull();
      expect(DECLARED[entry.id]?.class.density, entry.id).not.toBeNull();
    }
  });

  test('every scan is allowed or owed', () => {
    const owed = (id: string, axis: Axis) =>
      KNOWN_DEBT.some((d) => d.id === id && d.axis === axis && d.measured);
    for (const entry of CATALOGUE) {
      const declared = DECLARED[entry.id];
      for (const axis of AXES) {
        if (declared?.class[axis] !== 'scan') continue;
        const why = declared.allowed?.[axis];
        const allowed = typeof why === 'string' && why.length > 10;
        expect(allowed || owed(entry.id, axis), `${entry.id} on ${axis}`).toBe(true);
        expect(allowed && owed(entry.id, axis), `${entry.id} on ${axis} is both allowed and owed`).toBe(
          false,
        );
      }
    }
  });

  test('a debt line names a scan, an open issue number and a PR of the plan table', () => {
    for (const line of KNOWN_DEBT) {
      const declared = DECLARED[line.id];
      expect(declared, line.id).toBeDefined();
      expect(line.issue, line.id).toBeGreaterThan(0);
      // no line is owed to a PR that has merged or is this one (PR 4); PR 9 carries what no earlier PR fixes
      expect(line.pr, line.id).toBeGreaterThanOrEqual(5);
      expect(line.pr, line.id).toBeLessThanOrEqual(9);
      if (line.measured) {
        expect(declared?.class[line.axis], `${line.id} on ${line.axis}`).toBe('scan');
        expect(declared?.allowed?.[line.axis], `${line.id} on ${line.axis}`).toBeUndefined();
      }
    }
    const keys = KNOWN_DEBT.map((d) => `${d.id}/${d.axis}/${d.issue}/${d.pr}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('the entries that read traces or patterns files declare how they behave above the limit, and no other does', () => {
    expect(SMALL_TABLE_ENTRIES.length).toBeGreaterThan(0);
    const declared = CATALOGUE.filter((e) => DECLARED[e.id]?.aboveThreshold !== undefined).map((e) => e.id);
    expect(declared.sort()).toEqual(SMALL_TABLE_ENTRIES.map((e) => e.id).sort());
    // a renamed builder would drop an entry from the selection silently: pin the ids
    expect(SMALL_TABLE_ENTRIES.map((e) => e.id).sort()).toEqual([
      'patterns',
      'spans.total.traces.long',
      'trace.get',
      'trace.has',
      'trace.logs',
      'trace.share',
      'traces.list.all',
      'traces.list.all.long',
      'traces.list.attr.long',
      'traces.list.long',
      'traces.list.short',
      'traces.list.statkey.long',
    ]);
    for (const entry of SMALL_TABLE_ENTRIES)
      expect(DECLARED[entry.id]?.aboveThreshold?.perRowGroup, entry.id).toBe(2);
  });

  test('the small-file debt (#281) is paid: no line of it remains', () => {
    expect(KNOWN_DEBT.filter((d) => d.issue === 281)).toEqual([]);
  });

  test('the merged-statistics debt (#272) is paid: no line of it remains', () => {
    expect(KNOWN_DEBT.filter((d) => d.issue === 272)).toEqual([]);
  });

  test('the unconditioned trace list reads traces alone: no debt line remains for it, and it is `files`', () => {
    for (const id of ['traces.list.all', 'traces.list.all.long']) {
      expect(KNOWN_DEBT.filter((d) => d.id === id)).toEqual([]);
      expect(DECLARED[id]?.class).toMatchObject({ retention: 'files', density: 'files' });
    }
  });

  test('the compaction debt (#283) is paid: no line of it remains', () => {
    expect(KNOWN_DEBT.filter((d) => d.issue === 283)).toEqual([]);
  });

  test('no debt line names an aggregate over rollup dimensions', () => {
    const rollup = new Set(ROLLUP_ENTRIES.map((e) => e.id));
    expect(ROLLUP_ENTRIES.length).toBeGreaterThan(0);
    expect(KNOWN_DEBT.filter((d) => rollup.has(d.id))).toEqual([]);
    // the entries the router answers from rollups under a long window, over dimensions: all `fixed` on retention and density.
    for (const id of rollup) {
      const entry = CATALOGUE.find((e) => e.id === id);
      if (entry === undefined || /\.(attr|text|residual)\./.test(id) || id.includes('facets.attr')) continue;
      expect(DECLARED[id]?.class, id).toMatchObject({ retention: 'fixed', density: 'fixed' });
      expect(['files', 'fixed']).toContain(DECLARED[id]?.class.window);
    }
  });

  test('the debt list has not grown', () => {
    expect(KNOWN_DEBT.length).toBeLessThanOrEqual(DEBT_MAX);
  });
});

describe('the split of the measurement', () => {
  const pairs = (): string[] =>
    SPLIT.flatMap(({ part, spacing }) =>
      part === 'cross'
        ? []
        : CATALOGUE.filter((e) => e.spacing === spacing && assertedAxes(e).includes(part)).map(
            (e) => `${e.id}/${part}`,
          ),
    );

  test('its files assert each (entry, axis) of DECLARED exactly once', () => {
    const declared = CATALOGUE.flatMap((e) => assertedAxes(e).map((axis) => `${e.id}/${axis}`));
    expect(declared.length).toBeGreaterThan(0);
    expect(pairs().sort()).toEqual(declared.sort());
  });

  test('every part has its file, and no other classes-*.test.ts exists', () => {
    const files = readdirSync(dirname(fileURLToPath(import.meta.url)))
      .filter((f) => /^classes-.*\.test\.ts$/.test(f))
      .sort();
    expect(files).toEqual(SPLIT.map(fileOf).sort());
  });

  test('every asserted axis has one of the four classes', () => {
    const classes: readonly CostClass[] = ['fixed', 'files', 'matched', 'scan'];
    for (const entry of CATALOGUE)
      for (const axis of assertedAxes(entry)) {
        const declared = DECLARED[entry.id]?.class[axis];
        expect(declared !== null && declared !== undefined && classes.includes(declared), entry.id).toBe(
          true,
        );
      }
  });

  test('each file runs the part its name says', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const split of SPLIT)
      expect(readFileSync(join(here, fileOf(split)), 'utf8'), fileOf(split)).toContain(
        `defineMeasuredFile('${split.part}', '${split.spacing}');`,
      );
  });

  test('writes the debt list and the entries for the prediction when asked', () => {
    if (OUT !== undefined) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'debt.json'), JSON.stringify(KNOWN_DEBT));
      // which entries carry a window: the others read every partition whatever the window of the shape
      writeFileSync(
        join(OUT, 'entries.json'),
        JSON.stringify(CATALOGUE.map((e) => ({ id: e.id, window: e.window }))),
      );
    }
    expect(true).toBe(true);
  });
});

/** The steps `stepsFor` makes, on the compacted shape: the report went through compaction, one partition per time group. */
async function compactedSteps(
  entry: CatalogueEntry,
  axis: Axis,
  shapes: readonly Shape[] = stepsOf(axis, entry.spacing, false, true),
): Promise<Step[]> {
  const declared = DECLARED[entry.id];
  const reference = declared?.scanOf === undefined ? entry : CATALOGUE.find((e) => e.id === declared.scanOf);
  if (reference === undefined) throw new Error(`${entry.id} names no entry to compare with`);
  const steps: Step[] = [];
  for (const shape of shapes) {
    const cost = await measureEntry(entry, shape);
    const selectedGroups = (entry.window ? shape.inside : shape.outside + shape.inside) * shape.rowGroups;
    steps.push({
      partitions: shape.outside + shape.inside,
      selectedGroups,
      neededGroups: declared?.needed?.(shape) ?? selectedGroups,
      reference: reference === entry ? cost.serial : (await measureEntry(reference, shape)).serial,
      cost,
    });
  }
  return steps;
}

const RANK: Record<CostClass, number> = { fixed: 0, files: 1, matched: 2, scan: 3 };

/**
 * Retention is what the time bound of compaction protects (a windowed read stays `fixed` however many partitions lie
 * before the window), and window is the other axis the shape leaves comparable. Density is not measured on it: a
 * compacted file holds two partitions' rows, so at 8 row groups a logs file passes the harness's small-file limit
 * (350 KB, see `HARNESS_SMALL_FILE_BYTES`) that the plain shape's files stay under, and the entry reads it by range.
 * An entry may measure better than declared (a compacted file is read by metadata where the plain shape scans), never worse.
 */
const COMPACTED_AXES: readonly Axis[] = ['retention', 'window'];

describe.skipIf(SCALING !== '1')('the compacted shape (#283, PR 7)', { timeout: 180_000 }, () => {
  afterAll(async () => {
    await closeMeasured();
  });
  test.each(CATALOGUE.filter((e) => e.id.endsWith('.short')))(
    '$id keeps the classes it has on the plain shape when partitions are compactions of many',
    async (entry) => {
      for (const axis of assertedAxes(entry).filter((a) => COMPACTED_AXES.includes(a))) {
        const steps = await compactedSteps(entry, axis);
        const declared = DECLARED[entry.id]?.class[axis];
        const got = classify(steps);
        expect(
          declared != null && RANK[got] <= RANK[declared],
          `${entry.id} on ${axis}, compacted: ${got}, declared ${declared}: ${JSON.stringify(steps.map((s) => s.cost))}`,
        ).toBe(true);
      }
    },
    180_000,
  );

  /**
   * The steps above have two inside partitions, 12 h apart: a window of about 12 h, past `LONG_WINDOW_NS`, which the
   * router answers from rollups. This case has one inside slot (a window of about 10 min), so the entries read raw
   * files, and an odd number of outside slots, so the window's slot shares a compacted file with the last outside one:
   * the retention class then rests on pruning rows inside a compacted file, which only the time bound keeps constant.
   */
  const shortWindowSteps = (spacing: Shape['spacing']): Shape[] =>
    [3, 5, 9].map((outside) => ({
      outside,
      inside: 1,
      rowGroups: 2,
      spacing,
      compacted: true,
    }));
  const debt = CATALOGUE.filter((e) => ['spans.total.short', 'spans.total.long'].includes(e.id));
  test.each([...new Set([...debt, ...CATALOGUE.filter((e) => e.id.endsWith('.short'))])])(
    '$id keeps its retention class on a compacted report with a window under LONG_WINDOW_NS',
    async (entry) => {
      const shapes = shortWindowSteps(entry.spacing);
      for (const shape of shapes) {
        const r = await buildScalingReport(shape);
        expect(r.window.end - r.window.start, 'the window is short').toBeLessThan(LONG_WINDOW_NS);
      }
      if (!assertedAxes(entry).includes('retention')) return;
      const steps = await compactedSteps(entry, 'retention', shapes);
      const declared = DECLARED[entry.id]?.class.retention;
      const got = classify(steps);
      expect(
        declared != null && RANK[got] <= RANK[declared],
        `${entry.id} on retention, compacted, short window: ${got}, declared ${declared}: ${JSON.stringify(steps.map((s) => s.cost))}`,
      ).toBe(true);
    },
    180_000,
  );
});
