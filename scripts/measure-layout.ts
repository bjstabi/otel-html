// Measures the format-7 layout candidates (spec section 6.1): builds one live-shaped report (the `mixed` shape, partitions of
// the size of `rolling`'s) in today's layout, rewrites it once per candidate (sort x row-group size) and runs every
// `LAYOUT_STATEMENTS` entry and every catalogue entry cold in the counting engine. Prints the modelled serial requests and
// the bytes per statement and per entry against today's layout, and the pick rule's verdict.
//   bun scripts/measure-layout.ts [--candidates a:50000,b:16384,...] [--partitions N] [--bloom traces,logs,spans] [--json <file>]
// Sorts: a time DESC; b scope, time DESC; c scope, service, time DESC; d hour DESC, scope, service, time DESC.
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import type { LayoutOptions } from '../src/format/parquet/codec.js';
import type { SortKey, Table } from '../src/format/parquet/columns.js';
import { CATALOGUE } from '../src/viewer/data/catalogue.js';
import {
  buildFreshReport,
  isMerged,
  type ScalingReport,
  type Shape,
} from '../test-support/scaling/generator.js';
import {
  LAYOUT_STATEMENTS,
  type LayoutContext,
  measureStatement,
  prepareContext,
} from '../test-support/scaling/layout-statements.js';
import { type Live, measureCold, openLive } from '../test-support/scaling/measure.js';
import { relayoutReport } from '../test-support/scaling/relayout.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const print = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const HOUR_NS = 3_600_000_000_000n;
const SORTS = ['a', 'b', 'c', 'd'] as const;
type SortName = (typeof SORTS)[number];
const SIZES = [8192, 16_384, 50_000] as const;
const PRODUCTION_ROWS = 50_000;

const TIME_OF: Partial<Record<Table, string>> = {
  spans: 'start_time_unix_nano',
  span_rollups: 'start_time_unix_nano',
  logs: 'time_unix_nano',
  log_rollups: 'time_unix_nano',
};
const NO_DICTIONARY = [
  'trace_id',
  'span_id',
  'parent_span_id',
  'start_time_unix_nano',
  'end_time_unix_nano',
  'time_unix_nano',
  'observed_time_unix_nano',
] as const;

function sortKeys(sort: SortName, time: string): readonly SortKey[] {
  const t: SortKey = { column: time, dir: 'desc' };
  const scope: SortKey = { column: 'scope_name', dir: 'asc' };
  const service: SortKey = { column: 'service_name', dir: 'asc' };
  switch (sort) {
    case 'a':
      return [t];
    case 'b':
      return [scope, t];
    case 'c':
      return [scope, service, t];
    case 'd':
      return [{ column: time, dir: 'desc', bucketNs: HOUR_NS }, scope, service, t];
  }
}

const BLOOM = new Set<Table>((flag('--bloom') ?? 'traces,logs,spans').split(',') as Table[]);

function layoutOf(sort: SortName, rowGroupRows: number): LayoutOptions {
  const tables: Partial<Record<Table, readonly SortKey[]>> = {};
  for (const [table, time] of Object.entries(TIME_OF) as [Table, string][])
    tables[table] = sortKeys(sort, time);
  tables.points = [
    { column: 'scope_name', dir: 'asc' },
    { column: 'service_name', dir: 'asc' },
    { column: 'metric_name', dir: 'asc' },
    { column: 'time_unix_nano', dir: 'desc' },
  ];
  tables.traces = [{ column: 'start_time_unix_nano', dir: 'desc' }];
  return {
    sort: tables,
    rowGroupRows,
    noDictionary: NO_DICTIONARY,
    bloom: BLOOM,
  };
}

interface Result {
  name: string;
  statements: Record<string, { serial: number; bytes: number }>;
  entries: Record<string, { serial: number; bytes: number }>;
}

const MEASURED_ENTRIES = CATALOGUE.filter((e) => !isMerged(e));

async function measureReport(name: string, report: ScalingReport): Promise<Result> {
  const live: Live = await openLive(report);
  try {
    const ctx: LayoutContext = await prepareContext(live);
    const result: Result = { name, statements: {}, entries: {} };
    for (const s of LAYOUT_STATEMENTS) {
      const m = await measureStatement(live, s, ctx);
      result.statements[s.id] = { serial: m.cost.serial, bytes: m.cost.bytes };
    }
    for (const e of MEASURED_ENTRIES) {
      // a residual condition gives up past 200,000 candidate rows: it throws the same on every layout, and is left out
      const m = await measureCold(live, e).catch(() => undefined);
      if (m !== undefined) result.entries[e.id] = { serial: m.cost.serial, bytes: m.cost.bytes };
    }
    return result;
  } finally {
    await live.counting.close();
  }
}

const partitions = Number(flag('--partitions') ?? 6);
const base: Shape = {
  outside: partitions - 4,
  inside: 4,
  rowGroups: 3,
  spacing: 'dense',
  rowGroupRows: PRODUCTION_ROWS,
  mixed: true,
};
const candidates = (flag('--candidates') ?? SORTS.flatMap((s) => SIZES.map((n) => `${s}:${n}`)).join(','))
  .split(',')
  .map((c) => {
    const [sort, rows] = c.split(':');
    if (!SORTS.includes(sort as SortName) || !Number.isInteger(Number(rows)))
      throw new Error(`bad candidate ${c}`);
    return { sort: sort as SortName, rows: Number(rows) };
  });

const t0 = performance.now();
const stamp = (): string => `${((performance.now() - t0) / 1000).toFixed(0)} s`;
print(
  `measuring on ${availableParallelism()} cores; ${MEASURED_ENTRIES.length} catalogue entries, ${LAYOUT_STATEMENTS.length} statements`,
);
const built = await buildFreshReport(base);
print(
  `built the base report (${base.outside + base.inside} partitions x ${base.rowGroups * PRODUCTION_ROWS} spans) at ${stamp()}`,
);
const results: Result[] = [await measureReport('main', built)];
print(`main measured at ${stamp()}`);
for (const c of candidates) {
  const name = `${c.sort}/${c.rows}`;
  const report = await relayoutReport(built, layoutOf(c.sort, c.rows), c.rows);
  try {
    results.push(await measureReport(name, report));
  } finally {
    await report.close();
  }
  print(`${name} measured at ${stamp()}`);
}
await built.close();

// ---- the report
const main = results[0];
if (main === undefined) throw new Error('no main result');
const pathOf = new Map(LAYOUT_STATEMENTS.map((s) => [s.id, s.path] as const));
const strict = LAYOUT_STATEMENTS.filter((s) => s.path !== null).map((s) => s.id);
const cell = (r: Result, id: string): string => {
  const v = r.statements[id];
  return v === undefined ? '-' : `${v.serial} / ${(v.bytes / 1e6).toFixed(2)}`;
};
print('\n### Statements: modelled serial requests / MB, cold\n');
print(`| statement | path | ${results.map((r) => r.name).join(' | ')} |`);
print(`|${'---|'.repeat(results.length + 2)}`);
for (const s of LAYOUT_STATEMENTS)
  print(`| ${s.id} | ${s.path ?? '-'} | ${results.map((r) => cell(r, s.id)).join(' | ')} |`);

print('\n### Pick rule\n');
print('| candidate | section 7 sum | section 7 paths worse than main | other entries worse by > 10 % |');
print('|---|---|---|---|');
const verdicts: { name: string; sum: number; worse: string[]; slow: string[] }[] = [];
for (const r of results) {
  const sum = strict.reduce((a, id) => a + (r.statements[id]?.serial ?? 0), 0);
  const worse =
    r.name === 'main'
      ? []
      : strict.filter((id) => (r.statements[id]?.serial ?? 0) > (main.statements[id]?.serial ?? 0));
  const slow =
    r.name === 'main'
      ? []
      : [
          ...LAYOUT_STATEMENTS.filter((s) => s.path === null)
            .map((s) => s.id)
            .filter((id) => (r.statements[id]?.serial ?? 0) > 1.1 * (main.statements[id]?.serial ?? 0)),
          ...Object.keys(main.entries).filter(
            (id) => (r.entries[id]?.serial ?? 0) > 1.1 * (main.entries[id]?.serial ?? 0),
          ),
        ];
  verdicts.push({ name: r.name, sum, worse, slow });
  print(`| ${r.name} | ${sum} | ${worse.join(', ') || '-'} | ${slow.length} |`);
}
print('\n### Entries worse than main by more than 10 %, per candidate (serial: main -> candidate)\n');
for (const r of results.slice(1)) {
  const v = verdicts.find((x) => x.name === r.name);
  if (v === undefined || v.slow.length === 0) continue;
  const text = (id: string): string => {
    const a = id in main.entries ? main.entries[id] : main.statements[id];
    const b = id in r.entries ? r.entries[id] : r.statements[id];
    return `${id} ${a?.serial} -> ${b?.serial}`;
  };
  print(`- ${r.name}: ${v.slow.map(text).join('; ')}`);
}
const json = flag('--json');
if (json !== undefined)
  writeFileSync(json, JSON.stringify({ results, verdicts, pathOf: [...pathOf] }, null, 1));
print(`\ntotal ${stamp()}`);
