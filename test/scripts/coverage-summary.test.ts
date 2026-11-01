import { expect, test } from 'vitest';
import { summaryTable } from '../../scripts/coverage-summary.js';

test('summaryTable renders one row per suite with the four percentages', () => {
  const pct = (p: number) => ({ total: 100, covered: p, pct: p });
  const out = summaryTable({
    'unit-node': { lines: pct(91.5), statements: pct(90), functions: pct(80), branches: pct(70) },
  });
  expect(out).toBe(
    '| suite | lines | statements | functions | branches |\n|---|---|---|---|---|\n| unit-node | 91.5% | 90% | 80% | 70% |\n',
  );
});
