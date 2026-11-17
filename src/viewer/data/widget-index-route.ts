import { conditionId, WIDGET_INDEX_EVALUATOR } from '../../config/widget-traces.js';
import type { ManifestV4 } from '../../format/manifest.js';
import type { Pruned } from '../../query/sql/prune.js';
import type { WidgetIndexRoute } from '../../query/sql/widget-index.js';

/**
 * What a traces widget tells the data source: its own `query`, the variable condition ANDed to it (null without
 * bindings) and the bindings (`key` is the resource attribute key, `value` its string value). The data source uses it
 * only when the request's condition is exactly `query` and `variables` joined (Plan note 12).
 */
export interface WidgetIndexHint {
  query: string;
  variables: string | null;
  bindings: readonly { key: string; value: string }[];
}

/**
 * Moves from `scan` the spans files whose partition's `widget_traces` index lists the hint's condition id and every
 * bound key. They become `route.files` (the partition's index file). `scan.all` turns false once anything moved;
 * `route` is null when nothing did, so a route never names no file.
 */
export function routeWidgetIndex(
  manifest: ManifestV4,
  scan: Pruned,
  hint: WidgetIndexHint,
): { scan: Pruned; route: WidgetIndexRoute | null } {
  const id = conditionId(hint.query);
  const index = new Map<string, string>();
  for (const p of manifest.partitions) {
    const spans = p.files.spans?.path;
    const entry = p.files.widget_traces;
    const covers = entry?.widgetIndex;
    if (spans === undefined || entry === undefined || covers === undefined) continue;
    if (covers.evaluator !== WIDGET_INDEX_EVALUATOR) continue;
    if (!covers.conditions.includes(id)) continue;
    if (!hint.bindings.every((b) => covers.variables.includes(b.key))) continue;
    index.set(spans, entry.path);
  }
  const kept: string[] = [];
  const moved: string[] = [];
  for (const path of scan.files) {
    const file = index.get(path);
    if (file === undefined) kept.push(path);
    else moved.push(file);
  }
  if (moved.length === 0) return { scan, route: null };
  return {
    scan: { files: kept, all: false, total: scan.total },
    route: { files: moved, condition: id, bindings: hint.bindings },
  };
}
