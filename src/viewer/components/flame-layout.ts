import type { SpanId } from '../../model/ids.js';
import { StatusCode } from '../../model/records.js';
import type { SpanRow } from '../data/span-query.js';
import { exclusiveNs, type TraceNode, type TraceTree } from '../data/trace-tree.js';
import { type ColorAssigner, createColorAssigner } from '../theme/palette.js';

export type FlameColorBy = 'service' | 'host' | 'scope';

export interface FlameOptions {
  colorBy: FlameColorBy;
  /** Case-insensitive substring of the span name or service; non-matching bars are dimmed, never removed. */
  filter: string;
  errorsOnly: boolean;
}

export interface FlameBar {
  spanId: SpanId;
  depth: number;
  start: number;
  end: number;
  label: string;
  colorIndex: number;
  error: boolean;
  dimmed: boolean;
}

export interface FlameLegendEntry {
  key: string;
  /** Fraction (0..1) of the trace's exclusive execution time spent in spans with this key. */
  share: number;
}

export interface FlameContext {
  /** Shared assigner so a service keeps its colour across views; a private one is used when absent. */
  colors?: ColorAssigner;
  /** The grouping key per span for `colorBy`; the default uses the service, the resource name or the scope ref. */
  keyOf?: (row: SpanRow, colorBy: FlameColorBy) => string;
}

function defaultKey(row: SpanRow, colorBy: FlameColorBy): string {
  switch (colorBy) {
    case 'service':
      return row.service;
    case 'host':
      return row.resource;
    case 'scope':
      return String(row.span.scope);
    default: {
      const never: never = colorBy;
      throw new Error(`unhandled colour-by ${String(never)}`);
    }
  }
}

/**
 * Flame layout of a trace tree: one bar per span in depth-first order (roots and orphans first-to-last by start,
 * children by start), at the span's own extent. Iterative, so a 50k-deep chain cannot overflow the stack.
 */
export function layoutFlame(
  tree: TraceTree,
  opts: FlameOptions,
  ctx: FlameContext = {},
): { bars: FlameBar[]; legend: FlameLegendEntry[] } {
  const colors = ctx.colors ?? createColorAssigner();
  const keyOf = ctx.keyOf ?? defaultKey;
  const needle = opts.filter.trim().toLowerCase();
  const bars: FlameBar[] = [];
  const exclusive = new Map<string, number>();
  let total = 0;

  const stack: TraceNode[] = [];
  for (let i = tree.roots.length - 1; i >= 0; i--) {
    const r = tree.roots[i];
    if (r !== undefined) stack.push(r);
  }
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    const { row } = n;
    const key = keyOf(row, opts.colorBy);
    const error = row.span.status.code === StatusCode.ERROR;
    const matches =
      needle === '' ||
      row.span.name.toLowerCase().includes(needle) ||
      row.service.toLowerCase().includes(needle);
    bars.push({
      spanId: row.span.spanId,
      depth: n.depth,
      start: row.span.start,
      end: row.span.end,
      label: `${row.service} · ${row.span.name}`,
      colorIndex: colors.colorFor(key),
      error,
      dimmed: !matches || (opts.errorsOnly && !error),
    });
    const own = exclusiveNs(n);
    exclusive.set(key, (exclusive.get(key) ?? 0) + own);
    total += own;
    for (let i = n.children.length - 1; i >= 0; i--) {
      const c = n.children[i];
      if (c !== undefined) stack.push(c);
    }
  }

  const legend = [...exclusive]
    .map(([key, ns]) => ({ key, share: total === 0 ? 0 : ns / total }))
    .sort((a, b) => b.share - a.share || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { bars, legend };
}
