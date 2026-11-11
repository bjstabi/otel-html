import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TABLE = 'test-support/shard-weights.json';
const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;

export type FileSeconds = Record<string, number>;

interface PwTest {
  results?: { duration?: number }[];
}
interface PwSuite {
  file?: string;
  specs?: { file?: string; tests?: PwTest[] }[];
  suites?: PwSuite[];
}

/** One decimal, never 0 (a file that took no time still weighs something). */
function tenths(seconds: number): number {
  return Math.max(0.1, Math.round(seconds * 10) / 10);
}

/**
 * Seconds per spec file from a Playwright JSON report: the sum of every test result's duration (all projects in the
 * report, so Chromium's `-file` and `-http` projects add up). Keys are the spec's basename, as in `e2e/*.spec.ts`.
 */
export function playwrightSeconds(report: { suites?: PwSuite[] }): FileSeconds {
  const out: FileSeconds = {};
  const visit = (suite: PwSuite): void => {
    for (const spec of suite.specs ?? []) {
      const file = (spec.file ?? suite.file ?? '').replaceAll('\\', '/').split('/').pop();
      if (!file) continue;
      const ms = (spec.tests ?? [])
        .flatMap((t) => t.results ?? [])
        .reduce((a, r) => a + (r.duration ?? 0), 0);
      out[file] = (out[file] ?? 0) + ms / 1000;
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, tenths(v)]));
}

/** The table with every file's seconds rounded to a tenth and the keys sorted, as it is committed. */
export function normalise(seconds: FileSeconds): FileSeconds {
  return Object.fromEntries(
    Object.entries(seconds)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, tenths(v)]),
  );
}

/** A Playwright run that hangs (a crashed browser) is killed after this long. */
const BROWSER_TIMEOUT_MS = 20 * 60_000;

function run(cmd: string, args: string[], env: Record<string, string>, timeout?: number): number {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
    ...(timeout === undefined ? {} : { timeout }),
  });
  if (r.error && r.status === null && !('code' in r.error && r.error.code === 'ETIMEDOUT')) throw r.error;
  return r.status ?? 1;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

interface Table {
  unit: FileSeconds;
  'unit-perf': FileSeconds;
  e2e: Record<string, FileSeconds>;
}

function readTable(): Table {
  const old = readJson(TABLE);
  return isRecord(old) ? (old as unknown as Table) : { unit: {}, 'unit-perf': {}, e2e: {} };
}

const PARTS = ['unit', ...BROWSERS] as const;

function main(): void {
  // `bun scripts/shard-weights.ts chromium unit` rewrites only those parts of the table.
  const wanted = process.argv.slice(2);
  const bad = wanted.filter((a) => !(PARTS as readonly string[]).includes(a));
  if (bad.length > 0) throw new Error(`unknown part ${bad.join(', ')}; the parts are ${PARTS.join(', ')}`);
  const has = (part: string): boolean => wanted.length === 0 || wanted.includes(part);
  const dir = mkdtempSync(join(tmpdir(), 'shard-weights-'));
  const failures: string[] = [];
  const table = readTable();
  const unit = (perf: boolean): FileSeconds => {
    const out = join(dir, perf ? 'perf.json' : 'main.json');
    const status = run(
      'pnpm',
      ['exec', 'vitest', 'run', '--reporter=default', '--reporter=./scripts/shard-weights-reporter.ts'],
      { OTEL_HTML_PERF_PASS: perf ? '1' : '0', OTEL_HTML_SHARD_WEIGHTS_OUT: out },
    );
    if (status !== 0) failures.push(`unit ${perf ? 'perf' : 'main'} pass exited ${status}`);
    const seconds = readJson(out);
    if (!isRecord(seconds)) throw new Error(`the unit reporter wrote no ${out}`);
    return normalise(seconds as FileSeconds);
  };
  if (has('unit')) {
    table.unit = unit(false);
    table['unit-perf'] = unit(true);
  }
  for (const browser of BROWSERS) {
    if (!has(browser)) continue;
    const out = join(dir, `${browser}.json`);
    const projects = [`${browser}-file`, `${browser}-http*`].flatMap((p) => ['--project', p]);
    const status = run(
      'pnpm',
      ['exec', 'playwright', 'test', ...projects, '--grep-invert', '@perf', '--reporter=json'],
      { PLAYWRIGHT_JSON_OUTPUT_NAME: out },
      BROWSER_TIMEOUT_MS,
    );
    if (status !== 0) failures.push(`${browser} main pass exited ${status}`);
    const report = readJson(out);
    if (!isRecord(report)) {
      failures.push(`${browser} wrote no report; its part of the table is unchanged`);
      continue;
    }
    // A spec with no main-pass test in this browser (only @perf tests, or skipped without its env var) weighs the
    // least, not the median: it runs nothing in a shard.
    const idle = Object.fromEntries(
      readdirSync('e2e')
        .filter((f) => f.endsWith('.spec.ts'))
        .map((f) => [f, 0.1]),
    );
    table.e2e[browser] = normalise({ ...idle, ...playwrightSeconds(report) });
  }

  writeFileSync(TABLE, `${JSON.stringify(table, null, 2)}\n`);
  process.stdout.write(`wrote ${TABLE}\n`);
  for (const f of failures) process.stderr.write(`warning: ${f}; durations that were recorded are kept\n`);
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
