import type { LegacyDataSource } from '../data/legacy-data-source.js';
import type { SpanQuery, SpanQueryResult } from '../data/span-query.js';
import { type QueryHandle, type QueryRunner, useQuery } from '../state/use-query.js';

const runSpans: QueryRunner<SpanQuery, SpanQueryResult> = (ds, q, onProgress, signal) =>
  ds.querySpans(q, onProgress, signal);

/** `useQuery` over `querySpans`. */
export function useSpanQuery(dataSource: LegacyDataSource, query: SpanQuery): QueryHandle<SpanQueryResult> {
  return useQuery(dataSource, query, runSpans);
}
