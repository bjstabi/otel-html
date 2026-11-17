import type { ManifestV4 } from '../../format/manifest.js';
import { CORE_LOG_FACETS, CORE_SPAN_FACETS } from '../../query/sql/facets.js';
import { DEFAULT_FACET_CAPS } from './query-common.js';

/** UTF-8 byte order (DuckDB's string order), which is code point order, not JavaScript's UTF-16 code unit order. */
function byCodePoint(a: string, b: string): number {
  const x = a[Symbol.iterator]();
  const y = b[Symbol.iterator]();
  for (;;) {
    const p = x.next();
    const q = y.next();
    if (p.done === true || q.done === true) return p.done === q.done ? 0 : p.done === true ? -1 : 1;
    const d = (p.value.codePointAt(0) ?? 0) - (q.value.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
}

/**
 * The facet keys of a report's `spans` or `logs`, unfiltered, from the `attributeKeys` its files record: what
 * `attributeFacetsQuery` finds, without reading a file. Null when any file lacks the record (an older report, or a file
 * with more keys than the writer records) or has no file; the caller then scans.
 *
 * Same set, same order as the scan for the attribute keys: the core keys removed, then ranked by total and key, the
 * first `facetKeyCap` kept. The core keys come first in key order, as the scan lists those that have values; the scan
 * lists a core key without values last, which the manifest cannot tell, so a report that lacks one differs there.
 */
export function recordedFacetKeys(manifest: ManifestV4, table: 'spans' | 'logs'): string[] | null {
  const core = (table === 'spans' ? CORE_SPAN_FACETS : CORE_LOG_FACETS).map((c) => c.key);
  const files = manifest.partitions.flatMap((p) => {
    const f = p.files[table];
    return f === undefined ? [] : [f];
  });
  // no file: nothing to scan, and no key to record
  if (files.length === 0) return null;
  const totals = new Map<string, number>();
  for (const f of files) {
    if (f.attributeKeys === undefined) return null;
    for (const [key, n] of Object.entries(f.attributeKeys)) totals.set(key, (totals.get(key) ?? 0) + n);
  }
  for (const key of core) totals.delete(key);
  const cap = manifest.config.viewer.facetKeyCap ?? DEFAULT_FACET_CAPS.facetKeyCap;
  const attributes = [...totals]
    .sort(([a, m], [b, n]) => n - m || byCodePoint(a, b))
    .slice(0, cap)
    .map(([key]) => key);
  return [...[...core].sort(byCodePoint), ...attributes];
}
