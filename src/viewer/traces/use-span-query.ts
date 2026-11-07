import type { DataSource } from '../data/data-source.js';
import type { SpanQuery, SpanQueryResult } from '../data/results.js';
import { type QueryHandle, type QueryRunner, useQuery } from '../state/use-query.js';

const runSpans: QueryRunner<SpanQuery, SpanQueryResult> = (ds, q, signal) => ds.querySpans(q, signal);

/** `useQuery` over `querySpans`. */
export function useSpanQuery(dataSource: DataSource, query: SpanQuery): QueryHandle<SpanQueryResult> {
  return useQuery(dataSource, query, runSpans);
}
