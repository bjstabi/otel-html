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

const TERMS = 5;
/** The tolerance fitted coefficients are rounded to: counts are integers or simple fractions, floats are not. */
const ROUND = 1e9;

const featuresOf = (s: Size): number[] => [
  1,
  s.outside,
  s.outside * s.rowGroups,
  s.inside,
  s.inside * s.rowGroups,
];

/** Solves `m x = v` by Gauss-Jordan elimination with partial pivoting; throws when `m` is singular. */
function solve(m: number[][], v: number[]): number[] {
  const n = v.length;
  const aug = m.map((row, i) => [...row, v[i] ?? 0]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++)
      if (Math.abs(aug[row]?.[col] ?? 0) > Math.abs(aug[pivot]?.[col] ?? 0)) pivot = row;
    const p = aug[pivot];
    const c = aug[col];
    if (p === undefined || c === undefined || Math.abs(p[col] ?? 0) < 1e-9)
      throw new OtelHtmlError('usage', {
        message:
          'the measured shapes do not identify the cost model (they need all three axes and the cross)',
      });
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

/** Least squares over the points (the normal equations); coefficients are rounded to 1e-9 so exact models come back exact. */
export function fitModel(points: readonly { shape: Size; serial: number }[]): Model {
  const ata = Array.from({ length: TERMS }, () => new Array<number>(TERMS).fill(0));
  const atb = new Array<number>(TERMS).fill(0);
  for (const { shape, serial } of points) {
    const f = featuresOf(shape);
    for (let i = 0; i < TERMS; i++) {
      const row = ata[i];
      if (row === undefined) continue;
      for (let j = 0; j < TERMS; j++) row[j] = (row[j] ?? 0) + (f[i] ?? 0) * (f[j] ?? 0);
      atb[i] = (atb[i] ?? 0) + (f[i] ?? 0) * serial;
    }
  }
  const [a = 0, r = 0, rd = 0, w = 0, wd = 0] = solve(ata, atb).map((x) => Math.round(x * ROUND) / ROUND + 0);
  return { a, r, rd, w, wd };
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
