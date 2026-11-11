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
import { CROSS, type Shape, stepsOf } from './generator.js';
import { AXES, closeMeasured, pointsOf, printTable, stepsFor } from './measure.js';

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
  const shapes = part === 'cross' ? [{ ...CROSS, spacing }] : stepsOf(part, spacing);
  afterAll(async () => {
    await closeMeasured();
  });
  describe.skipIf(SCALING !== '1')(`measured classes: ${part} (${spacing})`, { timeout: 600_000 }, () => {
    test.each(entries)(
      '$id measures the class it declares',
      async (entry) => {
        const points = await pointsOf(entry, shapes);
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
      600_000,
    );

    test('prints the table when asked', async () => {
      if (PRINT === '1') await printTable();
      expect(true).toBe(true);
    });
  });
}
