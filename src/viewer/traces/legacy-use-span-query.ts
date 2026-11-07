import type { LegacyDataSource } from '../data/legacy-data-source.js';
import type { SpanQuery, SpanQueryResult } from '../data/span-query.js';
import { type LegacyQueryHandle, type LegacyQueryRunner, useLegacyQuery } from '../state/legacy-use-query.js';

const runSpans: LegacyQueryRunner<SpanQuery, SpanQueryResult> = (ds, q, onProgress, signal) =>
  ds.querySpans(q, onProgress, signal);

/** The dashboards' span query (legacy scan shapes), until 5.4 moves them to `useSpanQuery`. */
export function useLegacySpanQuery(
  dataSource: LegacyDataSource,
  query: SpanQuery,
): LegacyQueryHandle<SpanQueryResult> {
  return useLegacyQuery(dataSource, query, runSpans);
}
