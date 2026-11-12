import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { OtelHtmlError } from '../src/model/errors.js';
import {
  type AxisName,
  anchored,
  type CostModels,
  countCalls,
  type EntryFit,
  type FilesLine,
  type FitPoint,
  filesParallel,
  fitEntry,
  fitPage,
  improvedFit,
  MS_PER_MB,
  PAGE_CROSS_SIZE,
  PARALLEL_BATCH_MS,
  type PageEntry,
  type PartitionShape,
  predictPage,
  SERIAL_REQUEST_MS,
  scaledPage,
  splitWindow,
  TABLES,
  type Table,
  type Target,
} from '../test-support/scaling/model.js';

/**
 * Prints the requests, megabytes and modelled milliseconds the viewer's pages cost on named report shapes. An estimate:
 * it asserts nothing. The recordings (what each page asks) and the measurements (what each catalogue entry costs on the
 * generated shapes) come from `mise run predict:queries`, which writes them to the folder of OTEL_HTML_SCALING_OUT.
 *
 *   bun scripts/predict-queries.ts [--after <pr>] [--window none|7d] [--threshold <bytes>] [--small-files on|off] [--dir <folder>]
 *
 * A page runs in one engine, where DuckDB's cache makes a read one entry shares with another free, so a page is not the
 * sum of its entries. Each page is rendered whole in one cold counting engine on the generated shapes (dense and sparse
 * spacing), and its serial requests, parallel requests and bytes are fitted by non-negative least squares as
 * `a + P (p + pd G)` (P partitions of G row groups; the page's window spans the report, so the partitions are read alike).
 * The prediction for a named shape is that fit. `--after <pr>` scales each partition term of the fit by the share of it
 * that the page's entries without a debt line for that PR carry: the shares come from the entries' own fits, per axis
 * (retention, window, density). A `files` line adds one parallel request per small file. The pages are measured with
 * small files on (under OTEL_HTML_SCALING_THRESHOLD, default 262,144) and off; `--small-files off` predicts from the off
 * measurement (main before PR 3), and the live-anchored rows take their ratio against it.
 */

const PAGES = ['#/dashboards/ci', '#/traces?mode=traces', '#/traces', '#/logs', '#/metrics'] as const;
const DAY_NS = 86_400_000_000_000n;
/** 256 grains of 2^16 ms (65,536,000,000 ns) each, 4.66 h: a window at least this long reads the long-window entries. */
const LONG_NS = 16_777_216_000_000n;
const SPANS_PER_ROW_GROUP = 50_000;
/** The production small-file threshold (decision 5), also `HARNESS_SMALL_FILE_BYTES` of the measurement. */
const DEFAULT_THRESHOLD = 524_288;
/** Chromium keeps this many connections to one host: a batch of parallel requests is this wide. */
const PARALLEL_WIDTH = 6;

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
const windowRaw = arg('--window') ?? 'none';
type WindowArg = 'none' | '7d';
const threshold = Number(arg('--threshold') ?? DEFAULT_THRESHOLD);
const smallFilesArg = arg('--small-files') ?? 'on';
if (smallFilesArg !== 'on' && smallFilesArg !== 'off')
  fail(`--small-files takes on or off, got ${smallFilesArg}`);
const { OTEL_HTML_SCALING_OUT: OUT } = process.env;
const dir = arg('--dir') ?? OUT ?? fail('no folder: set OTEL_HTML_SCALING_OUT or pass --dir');
if (!Number.isInteger(after) || after < 1)
  fail(`--after takes a PR number of the plan, got ${arg('--after')}`);
if (windowRaw !== 'none' && windowRaw !== '7d') fail(`--window takes none or 7d, got ${windowRaw}`);
const windowArg: WindowArg = windowRaw === '7d' ? '7d' : 'none';
if (!(threshold > 0)) fail(`--threshold takes a number of bytes, got ${arg('--threshold')}`);

// ---- the measurements and the recordings

const PointSchema = z.object({
  shape: z.object({
    outside: z.number(),
    inside: z.number(),
    rowGroups: z.number(),
    bigRowGroups: z.number().optional(),
  }),
  serial: z.number(),
  parallel: z.number(),
  bytes: z.number(),
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const EntriesSchema = z.array(z.object({ id: z.string(), window: z.boolean() }));
const WINDOWED = new Map(
  EntriesSchema.parse(readJson(join(dir, 'entries.json'))).map((e) => [e.id, e.window] as const),
);

const models = new Map<string, EntryFit>();
// One folder per entry, one file per (part, shape) the test files wrote; the base shape is measured by several parts.
for (const id of readdirSync(join(dir, 'measured'))) {
  const byShape = new Map<string, z.infer<typeof PointSchema>>();
  for (const file of readdirSync(join(dir, 'measured', id)).filter((f) => f.endsWith('.json')))
    for (const point of z.array(PointSchema).parse(readJson(join(dir, 'measured', id, file))))
      byShape.set(`${point.shape.outside}/${point.shape.inside}/${point.shape.rowGroups}`, point);
  const points = [...byShape.values()].map(
    (p): FitPoint => ({ shape: p.shape, serial: p.serial, parallel: p.parallel, bytes: p.bytes }),
  );
  try {
    models.set(id, fitEntry(points, WINDOWED.get(id) === false));
  } catch (e) {
    throw new OtelHtmlError('usage', {
      message: `${id}: ${e instanceof Error ? e.message : String(e)} (${points.length} measured shapes)`,
    });
  }
}

/** The pages rendered whole on the generated shapes, fitted per page and spacing (short entries: dense; long: sparse). */
type PageSet = { fits: Map<string, CostModels>; points: Map<string, FitPoint[]>; threshold: number | null };
const isPageCross = (s: FitPoint['shape']): boolean =>
  s.outside === PAGE_CROSS_SIZE.outside &&
  s.inside === PAGE_CROSS_SIZE.inside &&
  s.rowGroups === PAGE_CROSS_SIZE.rowGroups &&
  s.bigRowGroups === undefined;
const pageKey = (page: string, long: boolean): string => `${page}|${long ? 'sparse' : 'dense'}`;
/** The page measurements of a folder (`pages`: small files on at the measured threshold; `pages-off`: none prepared). */
function loadPages(name: string): PageSet {
  const set: PageSet = { fits: new Map(), points: new Map(), threshold: null };
  for (const page of PAGES)
    for (const spacing of ['dense', 'sparse'] as const) {
      const folder = join(dir, name, encodeURIComponent(page));
      const files = readdirSync(folder).filter((f) => f.startsWith(`${spacing}-`) && f.endsWith('.json'));
      const points = files.map((f): FitPoint => {
        const raw = readJson(join(folder, f));
        const p = PointSchema.parse(raw);
        const t = (raw as { threshold?: unknown }).threshold;
        if (typeof t === 'number') set.threshold = t;
        return { shape: p.shape, serial: p.serial, parallel: p.parallel, bytes: p.bytes };
      });
      set.points.set(pageKey(page, spacing === 'sparse'), points);
      try {
        set.fits.set(pageKey(page, spacing === 'sparse'), fitPage(points));
      } catch (e) {
        throw new OtelHtmlError('usage', {
          message: `${page} (${spacing}): ${e instanceof Error ? e.message : String(e)} (${points.length} measured shapes)`,
        });
      }
    }
  return set;
}
const pagesOn = loadPages('pages');
const pagesOff = existsSync(join(dir, 'pages-off')) ? loadPages('pages-off') : null;
// The page measurement ran with one threshold (OTEL_HTML_SCALING_THRESHOLD, default 262,144): the one asked for here must be it.
if (pagesOn.threshold !== null && pagesOn.threshold !== threshold)
  fail(
    `the pages were measured with small files under ${pagesOn.threshold} bytes, not ${threshold}: run OTEL_HTML_SCALING_THRESHOLD=${threshold} mise run predict:queries -- --threshold ${threshold}`,
  );
if (smallFilesArg === 'off' && pagesOff === null)
  fail('no pages-off folder: the measurement ran without the small-files-off pass');
let active: PageSet = smallFilesArg === 'off' && pagesOff !== null ? pagesOff : pagesOn;
const pageFits = (): Map<string, CostModels> => active.fits;
const pagePoints = (): Map<string, FitPoint[]> => active.points;
/** Runs `fn` with the page measurements of small files on or off. */
function withSmallFiles<T>(mode: 'on' | 'off', fn: () => T): T {
  const held = active;
  const next = mode === 'off' ? pagesOff : pagesOn;
  if (next === null) return fail('no pages-off folder: the measurement ran without the small-files-off pass');
  active = next;
  try {
    return fn();
  } finally {
    active = held;
  }
}

/** A recorded call with the catalogue ids it maps to for a short and for a long window (the test maps, `entryIdsOf`). */
const CallSchema = z.object({
  call: z.object({
    method: z.string(),
    condition: z.enum(['none', 'sortkey', 'statkey', 'attr', 'text']),
    idKey: z.string().nullable(),
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
  z.object({
    id: z.string(),
    axis: z.enum(['retention', 'density', 'window']),
    pr: z.number(),
    target: z.enum(['fixed', 'files', 'matched', 'scan']),
  }),
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

function rollingShape(windowArg: WindowArg): Shape {
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
function syntheticShape(windowArg: WindowArg, runs: number, spans: number): Shape {
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

const shapesOf = (w: WindowArg): Shape[] => [
  rollingShape(w),
  syntheticShape(w, 30, 150_000),
  syntheticShape(w, 90, 150_000),
  syntheticShape(w, 30, 1_500_000),
];
const SHAPES = shapesOf(windowArg);

// ---- the debt lines

const AXIS_NAMES: readonly AxisName[] = ['retention', 'density', 'window'];
const RANK: Record<Target, number> = { scan: 0, matched: 1, files: 2, fixed: 3 };

/** The class an entry has reached on each axis after PR `after`: the best target among that axis' lines for that PR or an earlier one. */
function reached(id: string, after: number): Partial<Record<AxisName, Target>> {
  const best: Partial<Record<AxisName, Target>> = {};
  for (const d of KNOWN_DEBT) {
    const had = best[d.axis];
    if (d.id === id && d.pr <= after && (had === undefined || RANK[d.target] > RANK[had]))
      best[d.axis] = d.target;
  }
  return best;
}

// ---- the table

interface Cost {
  serial: number;
  parallel: number;
  bytes: number;
}

interface Row extends Cost {
  batches: number;
  /** Calls charged per catalogue id on this shape. */
  ids: Map<string, number>;
}

interface Config {
  after: number;
  window: WindowArg;
}
const CURRENT: Config = { after, window: windowArg };

function pageOn(page: string, shape: Shape, calls: readonly RecordedCall[], cfg: Config = CURRENT): Row {
  const counted = countCalls(
    calls.map((c) => ({
      method: c.call.method,
      idKey: c.call.idKey,
      ids: shape.long ? c.ids.long : c.ids.short,
      // no rollup answers a condition on an attribute or a text: it keeps its baseline whatever the PR
      baseline: c.call.condition === 'attr' || c.call.condition === 'text',
    })),
  );
  const entries: PageEntry[] = [];
  const small: FilesLine[] = [];
  const ids = new Map<string, number>();
  for (const [key, times] of counted) {
    const [id = '', baseline] = key.split('|');
    const fit = models.get(id) ?? fail(`no measurement for ${id}: run mise run predict:queries`);
    const axes = baseline === 'true' ? {} : reached(id, cfg.after);
    entries.push({ before: fit, after: improvedFit(fit, axes), times });
    small.push({
      times,
      axes: AXIS_NAMES.filter((a) => axes[a] === 'files'),
      windowless: fit.windowless,
    });
    ids.set(id, (ids.get(id) ?? 0) + times);
  }
  const measured = pageFits().get(pageKey(page, shape.long)) ?? fail(`no page fit for ${page}`);
  const model = scaledPage(cfg.window === 'none' ? measured : splitWindow(measured, entries), entries);
  const cost = predictPage(model, shape.partitions);
  // one parallel request per small file of the partitions a `files` axis covers
  const parallel = cost.parallel + filesParallel(small, shape.partitions);
  return {
    serial: cost.serial,
    parallel,
    bytes: cost.bytes,
    batches: Math.ceil(parallel / PARALLEL_WIDTH),
    ids,
  };
}

const fmt = (x: number): string => Math.round(x).toLocaleString('en-US');
const ms = (r: Row): number =>
  r.serial * SERIAL_REQUEST_MS + r.batches * PARALLEL_BATCH_MS + (r.bytes / 1e6) * MS_PER_MB;

print(
  `predicted requests after PR ${after}, window ${windowArg}, small files under ${threshold} bytes; snapshot of ${snapshot.takenAt}`,
);
{
  const fits = [...models.values()];
  const coefficients = [...fits, ...pageFits().values()].flatMap((f) => [
    ...Object.values(f.serial),
    ...Object.values(f.parallel),
    ...Object.values(f.bytes),
  ]);
  const windowless = fits.filter((f) => f.windowless);
  const alike = windowless.every((f) =>
    [f.serial, f.parallel, f.bytes].every((m) => m.r === m.w && m.rd === m.wd),
  );
  print(
    `models: ${fits.length} entries and ${pageFits().size} page fits, smallest coefficient ${Math.min(...coefficients)}; ${windowless.length} entries without a window, r = w and rd = wd held for ${alike ? 'all' : 'NOT all'}`,
  );
  for (const [key, f] of pageFits()) {
    const m = f.serial;
    print(
      `  page fit ${key}: serial ${m.a} + P (${m.w} + ${m.wd} G${m.q === undefined ? '' : ` + ${m.q} G^2`}); parallel ${f.parallel.a} + P (${f.parallel.w} + ${f.parallel.wd} G); bytes ${fmt(f.bytes.a)} + P (${fmt(f.bytes.w)} + ${fmt(f.bytes.wd)} G)`,
    );
  }
}
print(
  `the page fits are measured on row groups of ${SPANS_PER_ROW_GROUP.toLocaleString('en-US')} rows, 1 to 4 per partition, and one partition of 8, 14 and 22; a partition with more than 22 extrapolates the fit`,
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
    const r = pageOn(page, shape, calls);
    print(
      `  ${shape.name.padEnd(10)} ${fmt(r.serial).padStart(8)} ${fmt(r.parallel).padStart(9)} ${(r.bytes / 1e6).toFixed(1).padStart(9)} ${fmt(ms(r)).padStart(13)}`,
    );
    const cells = summary.get(shape.name) ?? ['', ''];
    if (page === PAGES[0]) cells[0] = fmt(r.serial);
    if (page === PAGES[1]) cells[1] = fmt(r.serial);
    summary.set(shape.name, cells);
  }
}

/** Within this share of the page in one engine, or this many requests (a page of 4 requests), the fit counts as right. */
const TOLERANCE = 0.25;
const SLACK = 2;
print('\none engine: the fit without CROSS against the page rendered whole (serial requests):');
print('  spacing  page                      shape                   predicted  measured  ratio');
const misses: string[] = [];
for (const spacing of ['dense', 'sparse'] as const)
  for (const page of PAGES) {
    const points = pagePoints().get(pageKey(page, spacing === 'sparse')) ?? [];
    const fit = fitPage(points.filter((p) => !isPageCross(p.shape)));
    const checked: [string, (p: FitPoint['shape']) => boolean][] = [
      [
        'BASE (2 x 2 groups)',
        (s) => s.outside + s.inside === 2 && s.rowGroups === 2 && s.bigRowGroups === undefined,
      ],
      ['CROSS (3 x 3 groups)', isPageCross],
      ['2 x 4 groups', (s) => s.outside + s.inside === 2 && s.rowGroups === 4],
      ['2 partitions, one of 22', (s) => s.bigRowGroups === 22],
    ];
    for (const [name, is] of checked) {
      const point = points.find((p) => is(p.shape));
      if (point === undefined) {
        misses.push(`${spacing} ${page} ${name}: not measured`);
        continue;
      }
      const s = point.shape;
      const partitions: PartitionShape[] = Array.from({ length: s.outside + s.inside }, (_, i) => ({
        rowGroups: i === 0 ? (s.bigRowGroups ?? s.rowGroups) : s.rowGroups,
        inWindow: true,
        smallFiles: 0,
      }));
      const predicted = predictPage(fit, partitions).serial;
      print(
        `  ${spacing.padEnd(7)}  ${page.padEnd(24)}  ${name.padEnd(22)} ${predicted.toFixed(1).padStart(10)} ${fmt(point.serial).padStart(9)} ${(predicted / point.serial).toFixed(2).padStart(6)}`,
      );
      if (!(Math.abs(predicted - point.serial) <= Math.max(SLACK, TOLERANCE * point.serial)))
        misses.push(
          `${spacing} ${page} ${name}: predicted ${predicted.toFixed(1)}, measured ${point.serial}`,
        );
    }
  }
if (misses.length > 0) process.exitCode = 1;

print('\nmapping, by catalogue entry (calls mapped on the rolling shape):');
for (const page of PAGES) {
  const r = pageOn(page, SHAPES[0] ?? fail('no shape'), recordings.get(page)?.calls ?? []);
  const rules = [...r.ids].map(([id, n]) => `${id} x${n}`).join(', ');
  print(`  ${page}: ${rules}`);
}

print(`\nexpectation row (serial requests, dashboard / trace list), after ${after}, window ${windowArg}:`);
print(`  ${[...summary].map(([name, [d, t]]) => `${name}: ${d} / ${t}`).join('   ')}`);
if (misses.length > 0) print(`\nthe one-engine check missed:\n  ${misses.join('\n  ')}`);

// The live-anchored rolling rows of the plan's Expectations table: what Chromium made on the live report (cold Range GETs
// plus HEADs, 2026-11-12) times this harness's rolling prediction after a PR over its prediction at PR 1.
const LIVE = { dashboard: 891, traces: 1064 };
const ANCHORED_ROWS: readonly (readonly [number, WindowArg])[] = [
  [1, 'none'],
  [3, 'none'],
  [4, 'none'],
  [6, 'none'],
  [8, '7d'],
];
{
  const rollingSerial = (page: string, cfg: Config): number =>
    pageOn(page, shapesOf(cfg.window)[0] ?? fail('no shape'), recordings.get(page)?.calls ?? [], cfg).serial;
  // row 1 is the page measured with no small file prepared: main before PR 3
  const base = withSmallFiles(pagesOff === null ? 'on' : 'off', () => ({
    dashboard: rollingSerial(PAGES[0], { after: 1, window: 'none' }),
    traces: rollingSerial(PAGES[1], { after: 1, window: 'none' }),
  }));
  print(
    `\nrolling, live-anchored (live ${fmt(LIVE.dashboard)} / ${fmt(LIVE.traces)} x harness after / harness with small files off), dashboard / trace list:`,
  );
  print('  after   window  harness rolling (unanchored)   ratio (dash / traces)   anchored');
  for (const [pr, window] of ANCHORED_ROWS) {
    const cfg = { after: pr, window };
    const [d, t] = withSmallFiles(pr === 1 && pagesOff !== null ? 'off' : 'on', () => [
      rollingSerial(PAGES[0], cfg),
      rollingSerial(PAGES[1], cfg),
    ]);
    print(
      `  ${String(pr).padEnd(5)}   ${window.padEnd(6)}  ${`${d.toFixed(1)} / ${t.toFixed(1)}`.padEnd(29)}  ${`${(d / base.dashboard).toFixed(3)} / ${(t / base.traces).toFixed(3)}`.padEnd(21)}   ${fmt(anchored(LIVE.dashboard, base.dashboard, d))} / ${fmt(anchored(LIVE.traces, base.traces, t))}`,
    );
  }
}
