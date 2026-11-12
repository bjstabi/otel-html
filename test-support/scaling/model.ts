import { OtelHtmlError } from '../../src/model/errors.js';

/** The part of a generated `Shape` the model reads (the script that prints predictions imports no generator). */
export interface Size {
  outside: number;
  inside: number;
  rowGroups: number;
}

/** `serial = a + R * (r + rd * G) + W * (w + wd * G)`: R partitions outside the window, W inside, G row groups each. */
export interface Model {
  a: number;
  r: number;
  rd: number;
  w: number;
  wd: number;
}

export interface PartitionShape {
  rowGroups: number;
  inWindow: boolean;
  /** Files of the partition under the small-file threshold. */
  smallFiles: number;
}

/** Milliseconds one serial request costs in Chromium against a static host (decision 4); printed, never asserted. */
export const SERIAL_REQUEST_MS = 15;
/** Milliseconds a batch of parallel requests costs (decision 4). */
export const PARALLEL_BATCH_MS = 50;
/** Milliseconds a megabyte costs (decision 4). */
export const MS_PER_MB = 62;

/** The tables of a partition; the script that prints predictions imports no generator, so the names live here. */
export const TABLES = ['spans', 'logs', 'points', 'traces', 'patterns'] as const;
export type Table = (typeof TABLES)[number];
export type AxisName = 'retention' | 'density' | 'window';
export type Target = 'fixed' | 'files' | 'matched' | 'scan';

/**
 * Chromium requests one open of a Parquet file costs, apart from the reads Node counts for it (calibration, Task 1: a
 * HEAD and DuckDB's `bytes=0-0` probe GET; the footer read is one of the Node reads). Here, not in cost.ts, so the script
 * that prints predictions reaches it without the counting engine's types; cost.ts re-exports it.
 */
export const REQUESTS_PER_OPEN = 2;

/** The tolerance fitted coefficients are rounded to: counts are integers or simple fractions, floats are not. */
const ROUND = 1e9;

const featuresOf = (s: Size): number[] => [
  1,
  s.outside,
  s.outside * s.rowGroups,
  s.inside,
  s.inside * s.rowGroups,
];
/** A request without a window reads every partition alike: one partition count, one density term. */
const uniformFeaturesOf = (s: Size): number[] => [
  1,
  s.outside + s.inside,
  (s.outside + s.inside) * s.rowGroups,
];

/** Solves `m x = v` by Gauss-Jordan elimination with partial pivoting; undefined when `m` is singular. */
function solve(m: number[][], v: number[]): number[] | undefined {
  const n = v.length;
  const aug = m.map((row, i) => [...row, v[i] ?? 0]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(aug[row]?.[col] ?? 0) > Math.abs(aug[pivot]?.[col] ?? 0)) pivot = row;
    const p = aug[pivot];
    const c = aug[col];
    if (p === undefined || c === undefined || Math.abs(p[col] ?? 0) < 1e-9) return undefined;
    aug[pivot] = c;
    aug[col] = p;
    const lead = p[col] ?? 1;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const target = aug[row];
      if (target === undefined) continue;
      const factor = (target[col] ?? 0) / lead;
      for (let k = col; k <= n; k++) target[k] = (target[k] ?? 0) - factor * (p[k] ?? 0);
    }
  }
  return aug.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

const unidentified = (): never => {
  throw new OtelHtmlError('usage', {
    message: 'the measured shapes do not identify the cost model (they need all three axes and the cross)',
  });
};

/**
 * Non-negative least squares of `y` on the feature rows: every subset of the features is solved on its own (at most five
 * features, so 31 small systems) and the best one whose coefficients are all >= 0 wins; the others are zero. Throws when
 * the full system is singular. Coefficients are rounded to 1e-9 so exact models come back exact.
 */
function nnls(rows: readonly number[][], y: readonly number[]): number[] {
  const n = rows[0]?.length ?? 0;
  const gram = (cols: readonly number[]): { ata: number[][]; atb: number[] } => {
    const ata = cols.map(() => new Array<number>(cols.length).fill(0));
    const atb = new Array<number>(cols.length).fill(0);
    rows.forEach((f, k) => {
      cols.forEach((ci, i) => {
        const row = ata[i];
        if (row === undefined) return;
        cols.forEach((cj, j) => {
          row[j] = (row[j] ?? 0) + (f[ci] ?? 0) * (f[cj] ?? 0);
        });
        atb[i] = (atb[i] ?? 0) + (f[ci] ?? 0) * (y[k] ?? 0);
      });
    });
    return { ata, atb };
  };
  const all = Array.from({ length: n }, (_, i) => i);
  const full = gram(all);
  if (solve(full.ata, full.atb) === undefined) return unidentified();
  const sumSquares = (coef: readonly number[]): number =>
    rows.reduce((total, f, k) => {
      const fit = coef.reduce((a, c, i) => a + c * (f[i] ?? 0), 0);
      return total + ((y[k] ?? 0) - fit) ** 2;
    }, 0);
  let best = new Array<number>(n).fill(0);
  let bestError = sumSquares(best);
  for (let mask = 1; mask < 1 << n; mask++) {
    const cols = all.filter((i) => (mask >> i) & 1);
    const { ata, atb } = gram(cols);
    const x = solve(ata, atb);
    if (x === undefined || x.some((v) => v < -1e-9)) continue;
    const coef = new Array<number>(n).fill(0);
    cols.forEach((c, i) => {
      coef[c] = Math.max(0, x[i] ?? 0);
    });
    const error = sumSquares(coef);
    if (error < bestError - 1e-9 * (1 + bestError)) {
      best = coef;
      bestError = error;
    }
  }
  return best.map((x) => Math.round(x * ROUND) / ROUND + 0);
}

/**
 * Non-negative least squares over the points. `windowless`: the request carries no window and reads every partition alike,
 * so the fit is constrained to `r = w` and `rd = wd`.
 */
export function fitModel(
  points: readonly { shape: Size; serial: number }[],
  options: { windowless?: boolean } = {},
): Model {
  const y = points.map((p) => p.serial);
  if (options.windowless === true) {
    const [a = 0, p = 0, pd = 0] = nnls(
      points.map((p) => uniformFeaturesOf(p.shape)),
      y,
    );
    return { a, r: p, rd: pd, w: p, wd: pd };
  }
  const [a = 0, r = 0, rd = 0, w = 0, wd = 0] = nnls(
    points.map((p) => featuresOf(p.shape)),
    y,
  );
  return { a, r, rd, w, wd };
}

/** The files of one table a request opens: `c + ro * R + wi * W` of them on a report of R/W partitions out/in the window. */
export interface OpenModel {
  c: number;
  ro: number;
  wi: number;
  /** Modelled footer ranges per open. */
  footer: number;
}

export interface FitPoint {
  shape: Size;
  /** Data-part serial requests (the cold cost less the open part). */
  serial: number;
  parallel: number;
  bytes: number;
  opens: Partial<Record<Table, { count: number; footer: number }>>;
}

/** What one catalogue entry costs on a page: its data part as three fitted models, and which files it opens. */
export interface EntryFit {
  windowless: boolean;
  serial: Model;
  parallel: Model;
  bytes: Model;
  opens: Partial<Record<Table, OpenModel>>;
}

/** The entry's data models and open counts, fitted on its measurements. */
export function fitEntry(points: readonly FitPoint[], windowless: boolean): EntryFit {
  const opens: Partial<Record<Table, OpenModel>> = {};
  for (const table of TABLES) {
    const seen = points.map((p) => p.opens[table]);
    const files = seen.reduce((a, o) => a + (o?.count ?? 0), 0);
    if (files === 0) continue;
    const rows = points.map((p) =>
      windowless ? [1, p.shape.outside + p.shape.inside] : [1, p.shape.outside, p.shape.inside],
    );
    const [c = 0, ro = 0, wi = 0] = nnls(
      rows,
      seen.map((o) => o?.count ?? 0),
    );
    opens[table] = windowless
      ? { c, ro, wi: ro, footer: seen.reduce((a, o) => a + (o?.footer ?? 0), 0) / files }
      : { c, ro, wi, footer: seen.reduce((a, o) => a + (o?.footer ?? 0), 0) / files };
  }
  const of = (pick: (p: FitPoint) => number): Model =>
    fitModel(
      points.map((p) => ({ shape: p.shape, serial: pick(p) })),
      { windowless },
    );
  return {
    windowless,
    serial: of((p) => p.serial),
    parallel: of((p) => p.parallel),
    bytes: of((p) => p.bytes),
    opens,
  };
}

/**
 * The fit of an entry once the PRs up to some point have landed, by axis (`reached`: the target of the best debt line
 * of each axis): `fixed` and `files` zero the axis' partition and density terms and the files it stops opening;
 * `matched` zeroes its density term; on density every target zeroes both density terms. A scan changes nothing.
 */
export function improvedFit(fit: EntryFit, reached: Partial<Record<AxisName, Target>>): EntryFit {
  const serial = { ...fit.serial };
  const bytes = { ...fit.bytes };
  const opens: Partial<Record<Table, OpenModel>> = {};
  for (const table of TABLES) {
    const o = fit.opens[table];
    if (o !== undefined) opens[table] = { ...o };
  }
  const cut = (models: Model[], terms: readonly (keyof Model)[]): void => {
    for (const m of models) for (const t of terms) m[t] = 0;
  };
  const flat = (t: Target | undefined): boolean => t === 'fixed' || t === 'files';
  const rt = reached.retention;
  if (flat(rt)) {
    cut([serial, bytes], ['r', 'rd']);
    for (const o of Object.values(opens)) o.ro = 0;
  } else if (rt === 'matched') cut([serial, bytes], ['rd']);
  const wt = reached.window;
  if (flat(wt)) {
    cut([serial, bytes], ['w', 'wd']);
    for (const o of Object.values(opens)) o.wi = 0;
  } else if (wt === 'matched') cut([serial, bytes], ['wd']);
  const dt = reached.density;
  if (dt !== undefined && dt !== 'scan') cut([serial, bytes], ['rd', 'wd']);
  return { ...fit, serial, bytes, opens };
}

/** What the data source records of a call, for counting it. */
export interface CountedCall {
  method: string;
  /** The id a by-id call asked for (a trace id, a log ref), null elsewhere. */
  idKey: string | null;
  /** The catalogue ids the call maps to. */
  ids: readonly string[];
  /** The call keeps its baseline whatever the PR (a condition on an attribute or a text). */
  baseline: boolean;
}

/** Methods whose result the data source remembers: the page pays for the first call only. */
const MEMOISED = new Set(['metricCatalog']);

/**
 * How many data parts a page pays per (catalogue id, baseline flag): a by-id call (an `idKey`) once per distinct id, a
 * memoised call once, any other call each time.
 */
export function countCalls(calls: readonly CountedCall[]): Map<string, number> {
  const counted = new Map<string, number>();
  const seen = new Set<string>();
  for (const call of calls)
    for (const id of call.ids) {
      const key = `${id}|${call.baseline}`;
      if (call.idKey !== null || MEMOISED.has(call.method)) {
        const once = `${key}|${call.idKey ?? ''}`;
        if (seen.has(once)) continue;
        seen.add(once);
      }
      counted.set(key, (counted.get(key) ?? 0) + 1);
    }
  return counted;
}

export interface PageEntry {
  fit: EntryFit;
  /** Data parts to charge: the calls, or the distinct ids of a by-id entry. */
  times: number;
  /** Axes on which the entry is `files`: its small files are fetched whole and in parallel instead. */
  filesAxes: readonly AxisName[];
}

export interface PageCost {
  serial: number;
  parallel: number;
  bytes: number;
  /** Serial requests of the union of opens (included in `serial`). */
  opens: number;
  /** Per entry, in order: the data part's serial requests and the parallel requests. */
  parts: { serial: number; parallel: number }[];
}

/**
 * The model summed over the partitions of a report: one `a`, then each partition by whether it is in the window. A
 * partition never costs less than nothing: the read-ahead makes a request grow slower than linearly with the row groups,
 * so a fitted line with a negative slope would otherwise go below zero on a shape larger than the ones it was fitted on.
 */
export function predict(model: Model, partitions: readonly PartitionShape[]): number {
  let total = model.a;
  for (const p of partitions)
    total += Math.max(0, p.inWindow ? model.w + model.wd * p.rowGroups : model.r + model.rd * p.rowGroups);
  return total;
}

/**
 * A page runs in one engine, so a file's footer read by one request is free to the next: the page pays the open
 * (`REQUESTS_PER_OPEN` plus the footer's ranges) once for each file in the union of what its entries open, and the sum of
 * the entries' data parts. The union per table takes the largest entry (the files of the entries nest): the outside
 * partitions of the entry opening most of them, plus the inside ones likewise.
 */
export function predictPage(entries: readonly PageEntry[], partitions: readonly PartitionShape[]): PageCost {
  const outside = partitions.filter((p) => !p.inWindow);
  const inside = partitions.filter((p) => p.inWindow);
  const cost: PageCost = { serial: 0, parallel: 0, bytes: 0, opens: 0, parts: [] };
  for (const table of TABLES) {
    const models = entries.flatMap((e) => (e.fit.opens[table] === undefined ? [] : [e.fit.opens[table]]));
    if (models.length === 0) continue;
    const files =
      Math.max(...models.map((m) => m.ro)) * outside.length +
      Math.max(...models.map((m) => m.c + m.wi * inside.length));
    cost.opens += files * (REQUESTS_PER_OPEN + Math.max(...models.map((m) => m.footer)));
  }
  cost.serial += cost.opens;
  for (const e of entries) {
    const serial = e.times * predict(e.fit.serial, partitions);
    // one parallel request per small file of the partitions a `files` axis covers
    const covered = partitions.filter(
      (p) =>
        (e.filesAxes.includes('retention') && !p.inWindow) ||
        (e.filesAxes.includes('window') && p.inWindow) ||
        (e.filesAxes.includes('density') && (p.inWindow || e.fit.windowless)),
    );
    const parallel =
      e.filesAxes.length > 0
        ? e.times * covered.reduce((a, p) => a + p.smallFiles, 0)
        : e.times * predict(e.fit.parallel, partitions);
    cost.serial += serial;
    cost.parallel += parallel;
    cost.bytes += e.times * predict(e.fit.bytes, partitions);
    cost.parts.push({ serial, parallel });
  }
  return cost;
}
