import { OtelHtmlError } from '../../src/model/errors.js';

/** The part of a generated `Shape` the model reads (the script that prints predictions imports no generator). */
export interface Size {
  outside: number;
  inside: number;
  rowGroups: number;
  /** Row groups of the first partition, when it is larger than the others. */
  bigRowGroups?: number | undefined;
}

/** The row groups of a shape summed over its partitions. */
const groupsOf = (s: Size): number =>
  (s.outside + s.inside) * s.rowGroups + (s.bigRowGroups === undefined ? 0 : s.bigRowGroups - s.rowGroups);

/** The squares of the row groups of each partition, summed (the first partition holds `bigRowGroups`). */
const squaredGroupsOf = (s: Size): number => {
  const partitions = s.outside + s.inside;
  const big = s.bigRowGroups ?? s.rowGroups;
  return (partitions - 1) * s.rowGroups ** 2 + big ** 2;
};

/** `serial = a + R * (r + rd * G) + W * (w + wd * G)`: R partitions outside the window, W inside, G row groups each. */
export interface Model {
  a: number;
  r: number;
  rd: number;
  w: number;
  wd: number;
  /** A page fit only: per partition, `q * G^2` more (the cost of a large partition grows faster than linearly). Absent when 0. */
  q?: number;
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
const uniformFeaturesOf = (s: Size): number[] => [1, s.outside + s.inside, groupsOf(s)];

/** `uniformFeaturesOf` with the squares of the partitions' row groups. */
const quadraticFeaturesOf = (s: Size): number[] => [...uniformFeaturesOf(s), squaredGroupsOf(s)];

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
  options: { windowless?: boolean; quadratic?: boolean } = {},
): Model {
  const y = points.map((p) => p.serial);
  if (options.windowless === true && options.quadratic === true) {
    const [a = 0, p = 0, pd = 0, q = 0] = nnls(
      points.map((p) => quadraticFeaturesOf(p.shape)),
      y,
    );
    return { a, r: p, rd: pd, w: p, wd: pd, ...(q > 0 ? { q } : {}) };
  }
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

export interface FitPoint {
  shape: Size;
  serial: number;
  parallel: number;
  bytes: number;
}

/** A cost as three fitted models: serial requests, parallel requests and bytes. */
export interface CostModels {
  serial: Model;
  parallel: Model;
  bytes: Model;
}

/** What one catalogue entry costs cold: its three models, and whether it carries no window. */
export interface EntryFit extends CostModels {
  windowless: boolean;
}

/** The three models fitted on the points; `windowless` constrains every one to `r = w` and `rd = wd`. */
function fitCosts(points: readonly FitPoint[], windowless: boolean, quadratic = false): CostModels {
  const of = (pick: (p: FitPoint) => number): Model =>
    fitModel(
      points.map((p) => ({ shape: p.shape, serial: pick(p) })),
      { windowless, quadratic },
    );
  return { serial: of((p) => p.serial), parallel: of((p) => p.parallel), bytes: of((p) => p.bytes) };
}

/** The entry's models, fitted on its cold measurements. */
export function fitEntry(points: readonly FitPoint[], windowless: boolean): EntryFit {
  return { windowless, ...fitCosts(points, windowless) };
}

/**
 * A page's models, fitted on the page rendered whole in one cold engine. The page's window spans the generated report,
 * so every partition is inside it and the page reads them alike: `r = w` and `rd = wd`, which also leaves the shapes
 * identified without the cross. A non-negative `G^2` term takes the curvature of the large partitions.
 */
export function fitPage(points: readonly FitPoint[]): CostModels {
  return fitCosts(points, true, true);
}

/**
 * The fit of an entry once the PRs up to some point have landed, by axis (`reached`: the target of the best debt line
 * of each axis): `fixed` and `files` zero the axis' partition and density terms;
 * `matched` zeroes its density term; on density every target zeroes both density terms. A scan changes nothing.
 * (An axis' parallel requests are not cut: a `files` line adds them back, per small file, in the script.)
 */
export function improvedFit(fit: EntryFit, reached: Partial<Record<AxisName, Target>>): EntryFit {
  const serial = { ...fit.serial };
  const bytes = { ...fit.bytes };
  const cut = (models: Model[], terms: readonly (keyof Model)[]): void => {
    for (const m of models) for (const t of terms) m[t] = 0;
  };
  const flat = (t: Target | undefined): boolean => t === 'fixed' || t === 'files';
  const rt = reached.retention;
  if (flat(rt)) {
    cut([serial, bytes], ['r', 'rd']);
  } else if (rt === 'matched') cut([serial, bytes], ['rd']);
  const wt = reached.window;
  if (flat(wt)) {
    cut([serial, bytes], ['w', 'wd']);
  } else if (wt === 'matched') cut([serial, bytes], ['wd']);
  const dt = reached.density;
  if (dt !== undefined && dt !== 'scan') cut([serial, bytes], ['rd', 'wd']);
  return { ...fit, serial, bytes };
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
  /** The entry's fit before any PR, and after the PRs up to the one asked for (`improvedFit`). */
  before: EntryFit;
  after: EntryFit;
  /** Calls to charge (`countCalls`): the weight of the entry in the page's shares. */
  times: number;
}

const TERMS = ['r', 'rd', 'w', 'wd'] as const;

/** The share of each partition term that the entries keep: what their `after` fits carry over what `before` carried. */
function sharesOf(
  entries: readonly PageEntry[],
  pick: (f: EntryFit) => Model,
): Record<(typeof TERMS)[number], number> {
  const share = { r: 1, rd: 1, w: 1, wd: 1 };
  for (const t of TERMS) {
    const before = entries.reduce((n, e) => n + e.times * pick(e.before)[t], 0);
    const after = entries.reduce((n, e) => n + e.times * pick(e.after)[t], 0);
    if (before > 0) share[t] = after / before;
  }
  return share;
}

/**
 * The page once the PRs up to some point have landed: each partition term (`r, rd, w, wd`) of each model is scaled by the
 * share of that term the page's entries still carry, each weighted by its calls. An entry `fixed` or `files` on an axis
 * carries none of it, `matched` its part without `G`; a term no entry carries is kept as measured.
 */
export function scaledPage(page: CostModels, entries: readonly PageEntry[]): CostModels {
  const scale = (m: Model, share: Record<(typeof TERMS)[number], number>): Model => ({
    a: m.a,
    r: m.r * share.r,
    rd: m.rd * share.rd,
    w: m.w * share.w,
    wd: m.wd * share.wd,
    ...(m.q === undefined ? {} : { q: m.q * share.wd }),
  });
  return {
    serial: scale(
      page.serial,
      sharesOf(entries, (f) => f.serial),
    ),
    parallel: scale(
      page.parallel,
      sharesOf(entries, (f) => f.parallel),
    ),
    bytes: scale(
      page.bytes,
      sharesOf(entries, (f) => f.bytes),
    ),
  };
}

/**
 * A page measured with its window over the whole report cannot tell a partition outside a narrower window from one
 * inside: the outside terms take the ratio of outside to inside cost of the page's entries (at most 1) times the inside
 * terms. Used only to read a page through a window shorter than the report.
 */
export function splitWindow(page: CostModels, entries: readonly PageEntry[]): CostModels {
  const split = (m: Model, pick: (f: EntryFit) => Model): Model => {
    const sum = (t: 'r' | 'rd' | 'w' | 'wd'): number =>
      entries.reduce((n, e) => n + e.times * pick(e.before)[t], 0);
    const ratio = (o: 'r' | 'rd', i: 'w' | 'wd'): number => (sum(i) > 0 ? Math.min(1, sum(o) / sum(i)) : 1);
    return { ...m, r: m.w * ratio('r', 'w'), rd: m.wd * ratio('rd', 'wd') };
  };
  return {
    serial: split(page.serial, (f) => f.serial),
    parallel: split(page.parallel, (f) => f.parallel),
    bytes: split(page.bytes, (f) => f.bytes),
  };
}

export interface PageCost {
  serial: number;
  parallel: number;
  bytes: number;
}

/**
 * The model summed over the partitions of a report: one `a`, then each partition by whether it is in the window. A
 * partition never costs less than nothing: the read-ahead makes a request grow slower than linearly with the row groups,
 * so a fitted line with a negative slope would otherwise go below zero on a shape larger than the ones it was fitted on.
 */
export function predict(model: Model, partitions: readonly PartitionShape[]): number {
  let total = model.a;
  for (const p of partitions)
    total += Math.max(
      0,
      (p.inWindow ? model.w + model.wd * p.rowGroups : model.r + model.rd * p.rowGroups) +
        (model.q ?? 0) * p.rowGroups ** 2,
    );
  return total;
}

/** A page's cost on a report of those partitions: its fitted models summed over them. */
export function predictPage(page: CostModels, partitions: readonly PartitionShape[]): PageCost {
  return {
    serial: predict(page.serial, partitions),
    parallel: predict(page.parallel, partitions),
    bytes: predict(page.bytes, partitions),
  };
}

/** An entry's debt lines for the parallel count: calls, the axes it is `files` on, and whether it carries no window. */
export interface FilesLine {
  times: number;
  axes: readonly AxisName[];
  windowless: boolean;
}

/**
 * Parallel requests a `files` line adds: one per small file of the partitions its axis covers. Retention covers the
 * partitions outside the window, and for an entry without a window, which has none, every partition; window covers the
 * ones inside; density those inside, or every partition for an entry without a window.
 */
export function filesParallel(lines: readonly FilesLine[], partitions: readonly PartitionShape[]): number {
  let total = 0;
  for (const { times, axes, windowless } of lines) {
    const covered = partitions.filter(
      (p) =>
        (axes.includes('retention') && (!p.inWindow || windowless)) ||
        (axes.includes('window') && p.inWindow) ||
        (axes.includes('density') && (p.inWindow || windowless)),
    );
    total += times * covered.reduce((n, p) => n + p.smallFiles, 0);
  }
  return total;
}

/** The page shape the page fit leaves out to test how it extrapolates across both axes (the generator adds the spacing). */
export const PAGE_CROSS_SIZE: Pick<Size, 'outside' | 'inside' | 'rowGroups'> = {
  outside: 2,
  inside: 1,
  rowGroups: 3,
};
