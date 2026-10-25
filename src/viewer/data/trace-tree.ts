import type { SpanId } from '../../model/ids.js';
import type { SpanRow } from './span-query.js';

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
 * Duplicate span ids stay in the tree; `byId` maps an id to its first span.
 */
export function buildTraceTree(spans: readonly SpanRow[]): TraceTree {
  const sorted = [...spans].sort(byStart);
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

/** Exclusive time per service: each span's duration minus the time covered by its children (clipped to the span). */
export function exclusiveTimeByService(tree: TraceTree): { service: string; ns: number }[] {
  const totals = new Map<string, number>();
  const stack = [...tree.roots];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    const { start, end } = n.row.span;
    let covered = 0;
    let cursor: number = start;
    for (const c of n.children) {
      const from = Math.max(c.row.span.start, cursor);
      const to = Math.min(c.row.span.end, end);
      if (to > from) {
        covered += to - from;
        cursor = to;
      }
      stack.push(c);
    }
    totals.set(n.row.service, (totals.get(n.row.service) ?? 0) + Math.max(0, n.row.durationNs - covered));
  }
  return [...totals]
    .map(([service, ns]) => ({ service, ns }))
    .sort((a, b) => b.ns - a.ns || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
}
