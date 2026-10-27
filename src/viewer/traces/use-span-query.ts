import type { DataSource, SpanQuery, SpanQueryResult } from '../data/data-source.js';
import { type QueryHandle, type QueryRunner, useQuery } from '../state/use-query.js';

const runSpans: QueryRunner<SpanQuery, SpanQueryResult> = (ds, q, onProgress, signal) =>
  ds.querySpans(q, onProgress, signal);

/** `useQuery` over `querySpans`. */
export function useSpanQuery(dataSource: DataSource, query: SpanQuery): QueryHandle<SpanQueryResult> {
  return useQuery(dataSource, query, runSpans);
}
