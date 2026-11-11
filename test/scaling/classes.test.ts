import { afterAll, describe, expect, test } from 'vitest';
import {
  type Axis,
  CATALOGUE,
  type CostClass,
  DECLARED,
  KNOWN_DEBT,
} from '../../src/viewer/data/catalogue.js';
import { classify, type Step } from '../../test-support/scaling/classify.js';
import { AXES, closeMeasured, printTable, stepsFor } from '../../test-support/scaling/measure.js';

const { OTEL_HTML_SCALING_PRINT: PRINT, OTEL_HTML_SCALING: SCALING } = process.env;

/** The number of lines the known-debt list may hold; a PR that removes lines lowers it. */
const DEBT_MAX = 88;

afterAll(async () => {
  await closeMeasured();
});

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
      expect(line.pr, line.id).toBeGreaterThanOrEqual(3);
      expect(line.pr, line.id).toBeLessThanOrEqual(8);
      if (line.measured) {
        expect(declared?.class[line.axis], `${line.id} on ${line.axis}`).toBe('scan');
        expect(declared?.allowed?.[line.axis], `${line.id} on ${line.axis}`).toBeUndefined();
      }
    }
    const keys = KNOWN_DEBT.map((d) => `${d.id}/${d.axis}/${d.issue}/${d.pr}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('the debt list has not grown', () => {
    expect(KNOWN_DEBT.length).toBeLessThanOrEqual(DEBT_MAX);
  });
});

// The measurement takes minutes (it builds 14 reports and runs every entry cold on each): `mise run test:scaling` sets
// OTEL_HTML_SCALING=1 and `check` depends on it; the unit tasks skip it so it does not run twice.
describe.skipIf(SCALING !== '1')('measured classes', { timeout: 600_000 }, () => {
  test.each(CATALOGUE)(
    '$id measures the class it declares',
    async (entry) => {
      // every axis is measured before the first assertion, so the printed table is complete
      const measured: [Axis, CostClass, CostClass, Step[]][] = [];
      for (const axis of AXES) {
        const declared = DECLARED[entry.id]?.class[axis];
        if (declared === null || declared === undefined) continue;
        const steps = await stepsFor(entry, axis);
        measured.push([axis, classify(steps), declared, steps]);
      }
      for (const [axis, got, declared, steps] of measured) {
        expect(got, `${entry.id} on ${axis}: ${JSON.stringify(steps.map((s) => s.cost))}`).toBe(declared);
      }
    },
    600_000,
  );

  test('prints the table when asked', async () => {
    if (PRINT === '1') await printTable();
    expect(true).toBe(true);
  });
});
