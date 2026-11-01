import { appendFileSync, globSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Metric {
  readonly total: number;
  readonly covered: number;
  readonly pct: number;
}

/** The `total` object of vitest's `coverage-summary.json`. */
export interface CoverageSummary {
  readonly lines: Metric;
  readonly statements: Metric;
  readonly functions: Metric;
  readonly branches: Metric;
}

/** A Markdown table, one row per suite. */
export function summaryTable(summaries: Readonly<Record<string, CoverageSummary>>): string {
  const rows = Object.entries(summaries).map(
    ([suite, s]) =>
      `| ${suite} | ${s.lines.pct}% | ${s.statements.pct}% | ${s.functions.pct}% | ${s.branches.pct}% |\n`,
  );
  return `| suite | lines | statements | functions | branches |\n|---|---|---|---|---|\n${rows.join('')}`;
}

function main(): void {
  const summaries: Record<string, CoverageSummary> = {};
  for (const file of globSync('coverage/*/coverage-summary.json').sort()) {
    const parsed: { total: CoverageSummary } = JSON.parse(readFileSync(file, 'utf8'));
    summaries[basename(dirname(file))] = parsed.total;
  }
  const table = summaryTable(summaries);
  process.stdout.write(table);
  const { GITHUB_STEP_SUMMARY } = process.env;
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `## Unit coverage\n\n${table}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
