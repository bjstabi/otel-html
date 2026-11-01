import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadSummaries, summaryTable } from '../../scripts/coverage-summary.js';

test('summaryTable renders one row per suite with the four percentages', () => {
  const pct = (p: number) => ({ total: 100, covered: p, pct: p });
  const out = summaryTable({
    'unit-node': { lines: pct(91.5), statements: pct(90), functions: pct(80), branches: pct(70) },
  });
  expect(out).toBe(
    '| suite | lines | statements | functions | branches |\n|---|---|---|---|---|\n| unit-node | 91.5% | 90% | 80% | 70% |\n',
  );
});

const pct = (p: number) => ({ total: 100, covered: p, pct: p });
const total = { lines: pct(1), statements: pct(2), functions: pct(3), branches: pct(4) };

describe('loadSummaries', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cov-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (suite: string, body: string) => {
    mkdirSync(join(dir, suite), { recursive: true });
    writeFileSync(join(dir, suite, 'coverage-summary.json'), body);
  };

  test('returns both required suites', () => {
    write('unit-node', JSON.stringify({ total }));
    write('unit-viewer', JSON.stringify({ total }));
    expect(Object.keys(loadSummaries(dir))).toEqual(['unit-node', 'unit-viewer']);
  });

  test('names every missing suite', () => {
    write('unit-node', JSON.stringify({ total }));
    expect(() => loadSummaries(dir)).toThrow(/unit-viewer/);
    expect(() => loadSummaries(join(dir, 'nothing'))).toThrow(/unit-node.*unit-viewer/s);
  });

  test('a malformed file is named in the error', () => {
    write('unit-node', JSON.stringify({ total }));
    write('unit-viewer', '{not json');
    expect(() => loadSummaries(dir)).toThrow(/unit-viewer[/\\]coverage-summary\.json/);
  });

  test('a file without totals is named in the error', () => {
    write('unit-node', JSON.stringify({ total }));
    write('unit-viewer', '{}');
    expect(() => loadSummaries(dir)).toThrow(/unit-viewer[/\\]coverage-summary\.json/);
  });
});
