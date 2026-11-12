import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  type Axis,
  CATALOGUE,
  type CatalogueEntry,
  type CostClass,
  DECLARED,
} from '../../src/viewer/data/catalogue.js';
import { classify, type Step } from './classify.js';
import { REQUESTS_PER_OPEN, ROW_GROUP_ROWS } from './cost.js';
import { HARNESS_SMALL_FILE_BYTES } from './counting-engine.js';
import { BASE, buildScalingReport, CROSS, isMerged, type Shape, stepsOf } from './generator.js';
import {
  AXES,
  closeMeasured,
  DENSE_16,
  hasDensity16,
  pointsOf,
  printTable,
  smallSerialOf,
  stepsFor,
} from './measure.js';

/**
 * A part of the measurement: the three steps of one axis for the entries of one spacing, or `cross` (the shape that
 * makes the cost model identifiable). Each part is a file `test/scaling/classes-<part>-<spacing>.test.ts`, so vitest
 * runs the parts in separate workers.
 */
export type Part = Axis | 'cross';
export interface Split {
  part: Part;
  spacing: Shape['spacing'];
}

export const PARTS: readonly Part[] = ['retention', 'density', 'window', 'cross'];
export const SPACINGS: readonly Shape['spacing'][] = ['dense', 'sparse'];
export const SPLIT: readonly Split[] = PARTS.flatMap((part) =>
  SPACINGS.map((spacing) => ({ part, spacing })),
);
export const fileOf = ({ part, spacing }: Split): string => `classes-${part}-${spacing}.test.ts`;

/** The (entry, axis) pairs the classes are asserted on: the axes a declaration holds a class for. */
export function assertedAxes(entry: CatalogueEntry): Axis[] {
  const declared = DECLARED[entry.id]?.class;
  return AXES.filter((axis) => declared?.[axis] !== null && declared?.[axis] !== undefined);
}

const {
  OTEL_HTML_SCALING: SCALING,
  OTEL_HTML_SCALING_OUT: OUT,
  OTEL_HTML_SCALING_PRINT: PRINT,
} = process.env;

/**
 * The measured tests of one part. Each entry of the part's spacing is measured on the part's shapes; on an axis part
 * its class is asserted too (the window axis does not apply to an entry without a window: it is measured only for the
 * points). With `OTEL_HTML_SCALING_OUT`, the points of every (entry, shape) go to their own file
 * `measured/<entry>/<part>-<shape>.json`, so no two workers write one file.
 */
export function defineMeasuredFile(part: Part, spacing: Shape['spacing']): void {
  const entries = CATALOGUE.filter((e) => e.spacing === spacing);
  // the prediction's model is fitted with one more density step, measured only for the run that writes it
  const extra = part === 'density' && OUT !== undefined ? [{ ...BASE, spacing, rowGroups: DENSE_16 }] : [];
  const shapesOf = (entry: CatalogueEntry): Shape[] =>
    part === 'cross'
      ? [{ ...CROSS, spacing }]
      : [
          ...stepsOf(part, spacing, isMerged(entry)),
          ...(hasDensity16(entry)
            ? extra.map((x) => ({ ...x, ...(isMerged(entry) ? { merged: true } : {}) }))
            : []),
        ];
  afterAll(async () => {
    await closeMeasured();
  });
  // the cross shape (the largest of the class shapes) only feeds the prediction's fit: it asserts nothing, so it is
  // measured only for the run that writes the points
  const skipped = SCALING !== '1' || (part === 'cross' && OUT === undefined);
  describe.skipIf(skipped)(`measured classes: ${part} (${spacing})`, { timeout: 180_000 }, () => {
    test.each(entries)(
      '$id measures the class it declares',
      async (entry) => {
        const points = await pointsOf(entry, shapesOf(entry));
        if (OUT !== undefined) {
          const dir = join(OUT, 'measured', entry.id);
          mkdirSync(dir, { recursive: true });
          for (const point of points) {
            const { outside, inside, rowGroups } = point.shape;
            writeFileSync(
              join(dir, `${part}-${spacing}-${outside}-${inside}-${rowGroups}.json`),
              JSON.stringify([point]),
            );
          }
        }
        if (part === 'cross' || !assertedAxes(entry).includes(part)) return;
        const declared: CostClass | null | undefined = DECLARED[entry.id]?.class[part];
        const steps: Step[] = await stepsFor(entry, part);
        expect(classify(steps), `${entry.id} on ${part}: ${JSON.stringify(steps.map((s) => s.cost))}`).toBe(
          declared,
        );
      },
      180_000,
    );

    // every statement prepares the files it reads, so none of the files under the limit is read by range
    test.skipIf(part === 'cross')(
      'no entry makes a serial read of a file under the small-file limit',
      async () => {
        for (const entry of entries)
          for (const shape of shapesOf(entry))
            expect(await smallSerialOf(entry, shape), `${entry.id} on ${JSON.stringify(shape)}`).toBe(0);
      },
      180_000,
    );

    // the densest step with the limit at 0: the entries that read traces or patterns files stay within their factor
    test.skipIf(part !== 'density')(
      'an entry that reads small tables stays within its stated factor when every file is read by range',
      async () => {
        const shape = stepsOf('density', spacing).at(-1) as Shape;
        const report = await buildScalingReport(shape);
        const small = report.manifest.partitions
          .flatMap((p) => Object.values(p.files))
          .filter((f) => f.bytes <= HARNESS_SMALL_FILE_BYTES);
        const groups = small.reduce((n, f) => n + Math.ceil(f.rows / ROW_GROUP_ROWS), 0);
        for (const entry of entries) {
          const factor = DECLARED[entry.id]?.aboveThreshold;
          if (factor === undefined) continue;
          // threshold 0 loads nothing whole, but the size class (`smallSerialOf`, the `small` list above) is the harness
          // limit's: it counts the files that would be small
          const serial = await smallSerialOf(entry, shape, { threshold: 0 });
          const bound = REQUESTS_PER_OPEN * small.length + factor.perRowGroup * groups;
          expect(
            serial,
            `${entry.id}: ${small.length} small files, ${groups} row groups`,
          ).toBeLessThanOrEqual(bound);
        }
      },
      180_000,
    );

    test('prints the table when asked', async () => {
      if (PRINT === '1') await printTable();
      expect(true).toBe(true);
    });
  });
}
