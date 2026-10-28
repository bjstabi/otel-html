import { invariant } from '../../model/errors.js';
import { type ExpAgg, type HistAgg, mergeAgg } from '../../rollups/metric-agg.js';

export interface HistogramViews {
  /** Cells are [bucket start (RelNanos), value-bucket index, count]; `bounds` are the value buckets' upper bounds. */
  heat: { bounds: number[]; cells: [number, number, number][] } | null;
  distribution: { bounds: number[]; counts: number[] } | null;
}

/** Value buckets in ascending order with explicit-histogram layout: `counts.length === bounds.length + 1`. */
interface Layout {
  bounds: number[];
  countsOf(a: HistAgg | ExpAgg): number[];
}

function histLayout(first: HistAgg): Layout {
  return {
    bounds: [...first.bounds],
    countsOf: (a) => (a.k === 'hist' ? a.counts : []),
  };
}

/**
 * Exponential buckets laid out at the scale and zero threshold of the whole window's merge: negatives (most
 * negative first), the zero bucket, then positives.
 */
function expLayout(all: ExpAgg): Layout {
  const s = all.scale;
  const neg = all.negative;
  const pos = all.positive;
  const base = 2 ** -s;
  const uppers = [
    ...neg.counts.map((_, j) => -(2 ** ((neg.offset + neg.counts.length - 1 - j) * base))),
    all.zeroThreshold,
    ...pos.counts.map((_, j) => 2 ** ((pos.offset + j + 1) * base)),
  ];
  const empty: ExpAgg = {
    ...all,
    count: 0,
    sum: 0,
    min: null,
    max: null,
    zeroCount: 0,
    positive: { offset: 0, counts: [] },
    negative: { offset: 0, counts: [] },
  };
  return {
    bounds: uppers.slice(0, -1),
    countsOf(a) {
      const out = new Array<number>(uppers.length).fill(0);
      // Merging into an empty aggregate brings `a` to the window's scale and zero threshold.
      const x = mergeAgg(empty, a, 'heat');
      invariant(x.k === 'exp' && x.scale === s, 'bucket merges at the window scale');
      const negTop = neg.offset + neg.counts.length - 1;
      x.negative.counts.forEach((c, j) => {
        const at = negTop - (x.negative.offset + j);
        invariant(c === 0 || (at >= 0 && at < neg.counts.length), 'negative bucket inside the window layout');
        if (c > 0) out[at] = (out[at] ?? 0) + c;
      });
      out[neg.counts.length] = x.zeroCount;
      x.positive.counts.forEach((c, j) => {
        const at = neg.counts.length + 1 + (x.positive.offset + j - pos.offset);
        invariant(
          c === 0 || (at > neg.counts.length && at < uppers.length),
          'positive bucket inside the layout',
        );
        if (c > 0) out[at] = (out[at] ?? 0) + c;
      });
      return out;
    },
  };
}

/** Heatmap cells and the window's distribution from each time bucket's merged histogram (one bucket layout). */
export function histogramViews(
  merged: readonly (HistAgg | ExpAgg | undefined)[],
  b0: number,
  widthNs: number,
): HistogramViews {
  const present = merged.flatMap((a, j) => (a === undefined ? [] : [{ a, j }]));
  const first = present[0]?.a;
  if (first === undefined) return { heat: null, distribution: null };
  let layout: Layout;
  if (first.k === 'hist') layout = histLayout(first);
  else {
    let all: ExpAgg = first;
    for (const { a } of present.slice(1)) {
      const next = mergeAgg(all, a, 'heat');
      if (next.k === 'exp') all = next;
    }
    layout = expLayout(all);
  }
  const counts = new Array<number>(layout.bounds.length + 1).fill(0);
  const cells: [number, number, number][] = [];
  for (const { a, j } of present) {
    layout.countsOf(a).forEach((c, k) => {
      if (c === 0) return;
      cells.push([(b0 + j) * widthNs, k, c]);
      counts[k] = (counts[k] ?? 0) + c;
    });
  }
  return { heat: { bounds: layout.bounds, cells }, distribution: { bounds: layout.bounds, counts } };
}
