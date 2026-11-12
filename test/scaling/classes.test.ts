import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  type Axis,
  CATALOGUE,
  type CostClass,
  DECLARED,
  KNOWN_DEBT,
  SMALL_TABLE_ENTRIES,
} from '../../src/viewer/data/catalogue.js';
import { AXES } from '../../test-support/scaling/measure.js';
import { assertedAxes, fileOf, SPLIT } from '../../test-support/scaling/measured-file.js';

const { OTEL_HTML_SCALING_OUT: OUT } = process.env;

/** The number of lines the known-debt list may hold; a PR that removes lines lowers it. */
const DEBT_MAX = 74;

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

  test('the entries that read traces or patterns files declare how they behave above the limit, and no other does', () => {
    expect(SMALL_TABLE_ENTRIES.length).toBeGreaterThan(0);
    const declared = CATALOGUE.filter((e) => DECLARED[e.id]?.aboveThreshold !== undefined).map((e) => e.id);
    expect(declared.sort()).toEqual(SMALL_TABLE_ENTRIES.map((e) => e.id).sort());
    for (const entry of SMALL_TABLE_ENTRIES)
      expect(DECLARED[entry.id]?.aboveThreshold?.perRowGroup, entry.id).toBe(2);
  });

  test('the small-file debt (#281) is paid: no line of it remains', () => {
    expect(KNOWN_DEBT.filter((d) => d.issue === 281)).toEqual([]);
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
