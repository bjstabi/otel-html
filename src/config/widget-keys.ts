import type { Expr, Value } from '../ottl/ast.js';
import { parseCondition } from '../ottl/parse.js';
import type { ResolvedDashboard } from './schema.js';

/** The widget types whose `query` a rollup can answer when it keeps the attributes the condition tests. */
const QUERY_WIDGETS = new Set(['toplist', 'table', 'traces']);

/** `attr:<key>` / `resource:<key>` of a path reading one attribute by its first key; null for any other path. */
function keyOf(v: Value): string | null {
  if (v.type !== 'path') return null;
  const segs = v.segments[0] === 'span' || v.segments[0] === 'log' ? v.segments.slice(1) : v.segments;
  const key = v.keys[0];
  if (typeof key !== 'string') return null;
  const canon = segs.join('.');
  if (canon === 'attributes') return `attr:${key}`;
  if (canon === 'resource.attributes') return `resource:${key}`;
  return null;
}

function collect(e: Expr, out: Set<string>): void {
  switch (e.type) {
    case 'and':
    case 'or':
      collect(e.left, out);
      collect(e.right, out);
      return;
    case 'not':
      collect(e.expr, out);
      return;
    case 'cmp': {
      if (e.op !== '==' && e.op !== '!=') return;
      for (const side of [e.left, e.right]) {
        const k = keyOf(side);
        if (k !== null) out.add(k);
      }
      return;
    }
    case 'value':
      return;
  }
}

/**
 * The `attr:` / `resource:` statistics keys the conditions of the dashboards' toplist, table and traces widgets test
 * by equality or presence (`attributes["k"] == "v"`, `... != nil`): the keys a rollup must group by to answer them.
 * A condition that does not parse contributes nothing (the config's own validation reports it). Sorted and distinct.
 */
export function widgetConditionKeys(dashboards: readonly ResolvedDashboard[]): string[] {
  const out = new Set<string>();
  for (const d of dashboards) {
    for (const w of d.dashboard.widgets) {
      if (!QUERY_WIDGETS.has(w.type) || !('query' in w) || w.query === null) continue;
      try {
        collect(parseCondition(w.query), out);
      } catch {
        // not a condition: nothing to add
      }
    }
  }
  return [...out].sort();
}
