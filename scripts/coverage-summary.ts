import { appendFileSync, globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const REQUIRED_SUITES = ['unit-node', 'unit-viewer'] as const;

function isMetric(v: unknown): v is Metric {
  return typeof v === 'object' && v !== null && 'pct' in v && typeof v.pct === 'number';
}

function parseTotal(file: string): CoverageSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const total = typeof parsed === 'object' && parsed !== null && 'total' in parsed ? parsed.total : undefined;
  if (
    typeof total !== 'object' ||
    total === null ||
    !('lines' in total && 'statements' in total && 'functions' in total && 'branches' in total) ||
    !(
      isMetric(total.lines) &&
      isMetric(total.statements) &&
      isMetric(total.functions) &&
      isMetric(total.branches)
    )
  ) {
    throw new Error(`${file}: no usable "total" object`);
  }
  return {
    lines: total.lines,
    statements: total.statements,
    functions: total.functions,
    branches: total.branches,
  };
}

/** The summaries of `unit-node` and `unit-viewer` under `root`; throws, naming what is missing or unreadable. */
export function loadSummaries(root: string): Record<string, CoverageSummary> {
  const files = new Map(
    globSync('*/coverage-summary.json', { cwd: root }).map((f) => [dirname(f), join(root, f)] as const),
  );
  const missing = REQUIRED_SUITES.filter((suite) => !files.has(suite));
  if (missing.length > 0) {
    throw new Error(`coverage summary missing for ${missing.join(', ')} under ${root}/`);
  }
  const summaries: Record<string, CoverageSummary> = {};
  for (const suite of REQUIRED_SUITES) summaries[suite] = parseTotal(files.get(suite) ?? '');
  return summaries;
}

function main(): void {
  let summaries: Record<string, CoverageSummary>;
  try {
    summaries = loadSummaries('coverage');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  const table = summaryTable(summaries);
  process.stdout.write(table);
  const { GITHUB_STEP_SUMMARY } = process.env;
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `## Unit coverage\n\n${table}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
