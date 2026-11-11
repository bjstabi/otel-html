import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { OtelHtmlError } from '../src/model/errors.js';
import {
  fitModel,
  type Model,
  MS_PER_MB,
  PARALLEL_BATCH_MS,
  type PartitionShape,
  predict,
  SERIAL_REQUEST_MS,
} from '../test-support/scaling/model.js';

/**
 * Prints the requests, megabytes and modelled milliseconds the viewer's pages cost on named report shapes. An estimate:
 * it asserts nothing. The recordings (what each page asks) and the measurements (what each catalogue entry costs on the
 * generated shapes) come from `mise run predict:queries`, which writes them to the folder of OTEL_HTML_SCALING_OUT.
 *
 *   bun scripts/predict-queries.ts [--after <pr>] [--window none|7d] [--threshold <bytes>] [--dir <folder>]
 *
 * Each entry's cost is a model fitted on the measurements, `a + R (r + rd G) + W (w + wd G)` (model.ts), summed over the
 * partitions of the shape. `--after <pr>` replaces the model of every entry that has a line in the known-debt list for
 * that PR or an earlier one by its target class.
 */

const PAGES = ['#/dashboards/ci', '#/traces?mode=traces', '#/traces', '#/logs', '#/metrics'] as const;
const DAY_NS = 86_400_000_000_000n;
/** 256 grains of the viewer's 65.5 ms base grain: a window at least this long reads the long-window entries. */
const LONG_NS = 16_777_216_000_000n;
const SPANS_PER_ROW_GROUP = 50_000;
/** The production small-file threshold (decision 5), also `HARNESS_SMALL_FILE_BYTES` of the measurement. */
const DEFAULT_THRESHOLD = 262_144;
/** Chromium keeps this many connections to one host: a batch of parallel requests is this wide. */
const PARALLEL_WIDTH = 6;
/** Methods whose result the data source remembers: the page pays for the first call only. */
const MEMOISED = new Set(['metricCatalog']);

const TABLES = ['spans', 'logs', 'points', 'traces', 'patterns'] as const;
type Table = (typeof TABLES)[number];

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}
const print = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};
const fail = (message: string): never => {
  throw new OtelHtmlError('usage', { message });
};

const after = Number(arg('--after') ?? 1);
const windowArg = arg('--window') ?? 'none';
const threshold = Number(arg('--threshold') ?? DEFAULT_THRESHOLD);
const { OTEL_HTML_SCALING_OUT: OUT } = process.env;
const dir = arg('--dir') ?? OUT ?? fail('no folder: set OTEL_HTML_SCALING_OUT or pass --dir');
if (!Number.isInteger(after) || after < 1)
  fail(`--after takes a PR number of the plan, got ${arg('--after')}`);
if (windowArg !== 'none' && windowArg !== '7d') fail(`--window takes none or 7d, got ${windowArg}`);
if (!(threshold > 0)) fail(`--threshold takes a number of bytes, got ${arg('--threshold')}`);

// ---- the measurements and the recordings

const PointSchema = z.object({
  shape: z.object({ outside: z.number(), inside: z.number(), rowGroups: z.number() }),
  serial: z.number(),
  parallel: z.number(),
  bytes: z.number(),
});
interface Models {
  serial: Model;
  parallel: Model;
  bytes: Model;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const models = new Map<string, Models>();
for (const file of readdirSync(join(dir, 'measured')).filter((f) => f.endsWith('.json'))) {
  const points = z.array(PointSchema).parse(readJson(join(dir, 'measured', file)));
  const of = (pick: (p: z.infer<typeof PointSchema>) => number): Model =>
    fitModel(points.map((p) => ({ shape: { ...p.shape, spacing: 'dense' }, serial: pick(p) })));
  models.set(file.replace(/\.json$/, ''), {
    serial: of((p) => p.serial),
    parallel: of((p) => p.parallel),
    bytes: of((p) => p.bytes),
  });
}

/** A recorded call with the catalogue ids it maps to for a short and for a long window (the test maps, `entryIdsOf`). */
const CallSchema = z.object({
  call: z.object({
    method: z.string(),
    condition: z.enum(['none', 'sortkey', 'statkey', 'attr', 'text']),
  }),
  ids: z.object({ short: z.array(z.string()), long: z.array(z.string()) }),
});
type RecordedCall = z.infer<typeof CallSchema>;
const RecordingSchema = z.object({
  calls: z.array(CallSchema),
  /** What the page cost on the generated base report when it ran in one engine, as the counting engine saw it. */
  warm: z.object({ serial: z.number(), parallel: z.number(), bytes: z.number() }),
});
const recordings = new Map<string, z.infer<typeof RecordingSchema>>();
for (const page of PAGES)
  recordings.set(
    page,
    RecordingSchema.parse(readJson(join(dir, 'recordings', `${encodeURIComponent(page)}.json`))),
  );

const DebtSchema = z.array(
  z.object({ id: z.string(), pr: z.number(), target: z.enum(['fixed', 'files', 'matched', 'scan']) }),
);
const KNOWN_DEBT = DebtSchema.parse(readJson(join(dir, 'debt.json')));

// ---- the shapes

const FileSchema = z.object({
  rows: z.number(),
  bytes: z.number(),
  timeMin: z.string().nullable(),
  timeMax: z.string().nullable(),
});
const SnapshotSchema = z.object({
  takenAt: z.string(),
  range: z.object({ start: z.string(), end: z.string() }),
  partitions: z.array(
    z.object({
      n: z.number(),
      files: z.object({
        spans: FileSchema.optional(),
        logs: FileSchema.optional(),
        points: FileSchema.optional(),
        traces: FileSchema.optional(),
        patterns: FileSchema.optional(),
      }),
    }),
  ),
});
const snapshot = SnapshotSchema.parse(
  readJson(new URL('../test-support/scaling/shapes/rolling.json', import.meta.url).pathname),
);

interface Shape {
  name: string;
  partitions: PartitionShape[];
  /** Whether the window the shape is read through is long (the `.long` entries). */
  long: boolean;
}

const lastDays = (rangeEnd: bigint): bigint => rangeEnd - 7n * DAY_NS;

function rollingShape(): Shape {
  const end = BigInt(snapshot.range.end);
  const start = BigInt(snapshot.range.start);
  const from = lastDays(end);
  const partitions = snapshot.partitions.map((p): PartitionShape => {
    const files = Object.values(p.files).flatMap((f) => (f === undefined ? [] : [f]));
    const mins = files.flatMap((f) => (f.timeMin === null ? [] : [BigInt(f.timeMin)]));
    const maxs = files.flatMap((f) => (f.timeMax === null ? [] : [BigInt(f.timeMax)]));
    const ascending = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
    const min = mins.sort(ascending)[0] ?? end;
    const max = maxs.sort(ascending).at(-1) ?? start;
    return {
      rowGroups: Math.max(1, Math.ceil((p.files.spans?.rows ?? 0) / SPANS_PER_ROW_GROUP)),
      inWindow: windowArg === 'none' || (max >= from && min <= end),
      smallFiles: files.filter((f) => f.bytes < threshold).length,
    };
  });
  const span = windowArg === 'none' ? end - start : 7n * DAY_NS;
  return { name: 'rolling', partitions, long: span >= LONG_NS };
}

/** Bytes per spans row (logs, traces) and bytes per file (points, patterns) of the snapshot's full partitions. */
function tableSizes(): { perSpan: Record<Table, number>; flat: Record<Table, number> } {
  const full = snapshot.partitions.filter((p) => (p.files.spans?.rows ?? 0) >= 100_000);
  const perSpan = { spans: 0, logs: 0, points: 0, traces: 0, patterns: 0 };
  const flat = { spans: 0, logs: 0, points: 0, traces: 0, patterns: 0 };
  for (const t of TABLES) {
    const bytes = full.reduce((a, p) => a + (p.files[t]?.bytes ?? 0), 0);
    const spans = full.reduce((a, p) => a + (p.files.spans?.rows ?? 0), 0);
    perSpan[t] = spans === 0 ? 0 : bytes / spans;
    flat[t] = full.length === 0 ? 0 : bytes / full.length;
  }
  return { perSpan, flat };
}

/** `runs` partitions a day apart of `spans` spans each: the files that grow with the spans scale from the snapshot's. */
function syntheticShape(runs: number, spans: number): Shape {
  const { perSpan, flat } = tableSizes();
  const sizes: Record<Table, number> = {
    spans: perSpan.spans * spans,
    logs: perSpan.logs * spans,
    points: flat.points,
    traces: perSpan.traces * spans,
    patterns: flat.patterns,
  };
  const smallFiles = TABLES.filter((t) => sizes[t] < threshold).length;
  const rowGroups = Math.ceil(spans / SPANS_PER_ROW_GROUP);
  const lastWeek = windowArg === '7d' ? 7 : runs;
  const partitions = Array.from(
    { length: runs },
    (_, i): PartitionShape => ({ rowGroups, inWindow: i >= runs - lastWeek, smallFiles }),
  );
  const span = windowArg === 'none' ? BigInt(runs) * DAY_NS : 7n * DAY_NS;
  return {
    name: `${runs}x${spans >= 1_000_000 ? `${spans / 1_000_000}M` : `${spans / 1000}k`}`,
    partitions,
    long: span >= LONG_NS,
  };
}

/** The generated base report the recordings were made on (2 + 2 partitions of 2 row groups): the model against a run. */
const HARNESS: Shape = {
  name: 'harness',
  partitions: Array.from(
    { length: 4 },
    (): PartitionShape => ({ rowGroups: 2, inWindow: true, smallFiles: 0 }),
  ),
  long: true,
};
const SHAPES: Shape[] = [
  rollingShape(),
  syntheticShape(30, 150_000),
  syntheticShape(90, 150_000),
  syntheticShape(30, 1_500_000),
];

// ---- the debt lines

type Target = 'fixed' | 'files' | 'matched' | 'scan';
const RANK: Record<Target, number> = { scan: 0, matched: 1, files: 2, fixed: 3 };

/** The class an entry has reached after PR `after`: the best target among its debt lines for that PR or an earlier one. */
function reached(id: string): Target | null {
  let best: Target | null = null;
  for (const d of KNOWN_DEBT)
    if (d.id === id && d.pr <= after && (best === null || RANK[d.target] > RANK[best])) best = d.target;
  return best;
}

interface Cost {
  serial: number;
  parallel: number;
  bytes: number;
}

function costOf(id: string, call: RecordedCall, partitions: readonly PartitionShape[]): Cost {
  const m = models.get(id) ?? fail(`no measurement for ${id}: run mise run predict:queries`);
  const baseline = (): Cost => ({
    serial: predict(m.serial, partitions),
    parallel: predict(m.parallel, partitions),
    bytes: predict(m.bytes, partitions),
  });
  // no rollup answers a condition on an attribute or a text: it keeps its baseline whatever the PR
  if (call.call.condition === 'attr' || call.call.condition === 'text') return baseline();
  const target = reached(id);
  const zeroed = (x: Model): Model => ({ a: x.a, r: 0, rd: 0, w: 0, wd: 0 });
  const flattened = (x: Model): Model => ({ ...x, rd: 0, wd: 0 });
  switch (target) {
    case null:
    case 'scan':
      return baseline();
    case 'fixed':
      return {
        serial: predict(zeroed(m.serial), partitions),
        parallel: predict(m.parallel, partitions),
        bytes: predict(zeroed(m.bytes), partitions),
      };
    case 'files':
      return {
        serial: predict(zeroed(m.serial), partitions),
        // one parallel request per small file of the partitions the request reads
        parallel: partitions.reduce((a, p) => a + p.smallFiles, 0),
        bytes: predict(m.bytes, partitions),
      };
    case 'matched':
      return {
        serial: predict(flattened(m.serial), partitions),
        parallel: predict(m.parallel, partitions),
        bytes: predict(flattened(m.bytes), partitions),
      };
    default: {
      const never: never = target;
      return never;
    }
  }
}

// ---- the table

interface Row extends Cost {
  batches: number;
  ids: Map<string, { calls: number; serial: number }>;
}

function pageOn(shape: Shape, calls: readonly RecordedCall[]): Row {
  const row: Row = { serial: 0, parallel: 0, bytes: 0, batches: 0, ids: new Map() };
  const seen = new Set<string>();
  for (const call of calls) {
    if (MEMOISED.has(call.call.method)) {
      if (seen.has(call.call.method)) continue;
      seen.add(call.call.method);
    }
    for (const id of shape.long ? call.ids.long : call.ids.short) {
      const c = costOf(id, call, shape.partitions);
      row.serial += c.serial;
      row.parallel += c.parallel;
      row.bytes += c.bytes;
      if (c.parallel > 0) row.batches += Math.ceil(c.parallel / PARALLEL_WIDTH);
      const so = row.ids.get(id) ?? { calls: 0, serial: 0 };
      row.ids.set(id, { calls: so.calls + 1, serial: so.serial + c.serial });
    }
  }
  return row;
}

const fmt = (x: number): string => Math.round(x).toLocaleString('en-US');
const ms = (r: Row): number =>
  r.serial * SERIAL_REQUEST_MS + r.batches * PARALLEL_BATCH_MS + (r.bytes / 1e6) * MS_PER_MB;

print(
  `predicted requests after PR ${after}, window ${windowArg}, small files under ${threshold} bytes; snapshot of ${snapshot.takenAt}`,
);
print(
  `serial ${SERIAL_REQUEST_MS} ms, a batch of ${PARALLEL_WIDTH} parallel requests ${PARALLEL_BATCH_MS} ms, ${MS_PER_MB} ms per MB; an estimate, nothing is asserted`,
);
const summary = new Map<string, string[]>();
for (const page of PAGES) {
  const calls = recordings.get(page)?.calls ?? [];
  print(`\n${page}  (${calls.length} calls)`);
  print('  shape        serial  parallel        MB   modelled ms');
  for (const shape of SHAPES) {
    const r = pageOn(shape, calls);
    print(
      `  ${shape.name.padEnd(10)} ${fmt(r.serial).padStart(8)} ${fmt(r.parallel).padStart(9)} ${(r.bytes / 1e6).toFixed(1).padStart(9)} ${fmt(ms(r)).padStart(13)}`,
    );
    const cells = summary.get(shape.name) ?? ['', ''];
    if (page === PAGES[0]) cells[0] = fmt(r.serial);
    if (page === PAGES[1]) cells[1] = fmt(r.serial);
    summary.set(shape.name, cells);
  }
  const base = pageOn(HARNESS, calls);
  const warm = recordings.get(page)?.warm;
  print(
    `  harness    ${fmt(base.serial).padStart(8)} ${fmt(base.parallel).padStart(9)} ${(base.bytes / 1e6).toFixed(1).padStart(9)}   (the page ran in one engine on it: ${fmt(warm?.serial ?? 0)} serial, ${((warm?.bytes ?? 0) / 1e6).toFixed(1)} MB)`,
  );
}

print('\nmapping, by catalogue entry (calls mapped on the rolling shape):');
for (const page of PAGES) {
  const r = pageOn(SHAPES[0] ?? fail('no shape'), recordings.get(page)?.calls ?? []);
  const rules = [...r.ids].map(([id, n]) => `${id} x${n.calls} (${fmt(n.serial)} serial)`).join(', ');
  print(`  ${page}: ${rules}`);
}

print(`\nexpectation row (serial requests, dashboard / trace list), after ${after}, window ${windowArg}:`);
print(`  ${[...summary].map(([name, [d, t]]) => `${name}: ${d} / ${t}`).join('   ')}`);
