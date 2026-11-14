import {
  exclusiveNsOf,
  isProvisionalValue,
  laterCopyWins,
  PROVISIONAL_ATTR,
  type ShareSpan,
  serviceShareOf,
} from '../../format/service-share.js';
import type { SpanId } from '../../model/ids.js';
import type { SpanRow } from './results.js';

export interface TraceNode {
  readonly row: SpanRow;
  readonly children: TraceNode[];
  depth: number;
}

export interface TraceTree {
  /** Root spans and orphans (parent absent) and, for malformed cyclic data, one promoted span per cycle; ordered by start. */
  readonly roots: TraceNode[];
  readonly byId: Map<SpanId, TraceNode>;
}

function isProvisional(row: SpanRow): boolean {
  return isProvisionalValue(row.span.attributes.get(PROVISIONAL_ATTR));
}

/** §5.5: of two rows with one span id, the one that is not provisional, else the one that ends later, else the first. */
function preferred(a: SpanRow, b: SpanRow): SpanRow {
  const copy = (r: SpanRow): { provisional: boolean; end: number } => ({
    provisional: isProvisional(r),
    end: r.span.end,
  });
  return laterCopyWins(copy(a), copy(b)) ? b : a;
}

/** One row per span id: the provisional copy of a CI span gives way to the final one. `getTrace` applies it to the whole detail; `buildTraceTree` repeats it, which costs one pass and is a no-op on deduped input. */
export function dedupeSpanIds(spans: readonly SpanRow[]): SpanRow[] {
  const kept = new Map<SpanId, SpanRow>();
  for (const r of spans) {
    const had = kept.get(r.span.spanId);
    kept.set(r.span.spanId, had === undefined ? r : preferred(had, r));
  }
  return kept.size === spans.length ? [...spans] : [...kept.values()];
}

function byStart(a: SpanRow, b: SpanRow): number {
  return (
    a.span.start - b.span.start ||
    (a.span.spanId < b.span.spanId ? -1 : a.span.spanId > b.span.spanId ? 1 : 0)
  );
}

/**
 * Parent/child tree of one trace. Every span is kept: spans whose parent is absent become extra roots,
 * a child that starts before its parent stays under it, and parent cycles (malformed data) are broken by
 * promoting the earliest-starting unreached span of each cycle to a root. Iterative, so depth cannot overflow the stack.
 * Rows sharing a span id collapse to one (a provisional CI span gives way to the final one, else the later end wins).
 */
export function buildTraceTree(spans: readonly SpanRow[]): TraceTree {
  const sorted = dedupeSpanIds(spans).sort(byStart);
  const nodes = sorted.map((row): TraceNode => ({ row, children: [], depth: 0 }));
  const byId = new Map<SpanId, TraceNode>();
  for (const n of nodes) if (!byId.has(n.row.span.spanId)) byId.set(n.row.span.spanId, n);

  const candidates = new Map<TraceNode, TraceNode[]>();
  const roots: TraceNode[] = [];
  for (const n of nodes) {
    const pid = n.row.span.parentSpanId;
    const parent = pid === null ? undefined : byId.get(pid);
    if (parent === undefined || parent === n) {
      if (parent === undefined) roots.push(n);
      continue;
    }
    const list = candidates.get(parent);
    if (list === undefined) candidates.set(parent, [n]);
    else list.push(n);
  }

  const visited = new Set<TraceNode>();
  const walk = (root: TraceNode): void => {
    visited.add(root);
    const stack = [root];
    for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
      for (const c of candidates.get(n) ?? []) {
        if (visited.has(c)) continue;
        visited.add(c);
        c.depth = n.depth + 1;
        n.children.push(c);
        stack.push(c);
      }
    }
  };
  for (const r of roots) walk(r);
  // Anything unreached hangs off a parent cycle (or a self-parent): promote in start order.
  for (const n of nodes) {
    if (visited.has(n)) continue;
    roots.push(n);
    walk(n);
  }
  roots.sort((a, b) => byStart(a.row, b.row));
  return { roots, byId };
}

/** A row as the shared service-share computation takes it. */
export function shareSpanOf(row: SpanRow): ShareSpan {
  const { spanId, parentSpanId, start, end } = row.span;
  return {
    spanId,
    parentId: parentSpanId,
    service: row.service,
    start,
    end,
    durationNs: row.durationNs,
    provisional: isProvisional(row),
  };
}

/** A span's own time: its duration minus the time covered by its children (clipped to the span, overlaps counted once). */
export function exclusiveNs(n: TraceNode): number {
  return Number(
    exclusiveNsOf(
      shareSpanOf(n.row),
      n.children.map((c) => shareSpanOf(c.row)),
    ),
  );
}

/** Exclusive time per service, largest first. */
export function exclusiveTimeByService(tree: TraceTree): { service: string; ns: number }[] {
  const spans: ShareSpan[] = [];
  const stack = [...tree.roots];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    for (const c of n.children) stack.push(c);
    spans.push(shareSpanOf(n.row));
  }
  return serviceShareOf(spans).map(({ service, ns }) => ({ service, ns: Number(ns) }));
}
