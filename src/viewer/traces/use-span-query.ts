import type { DataSource } from '../data/data-source.js';
import type { SpanPoint, SpanPointsQuery, SpanQuery, SpanQueryResult } from '../data/results.js';
import { type QueryHandle, type QueryRunner, useQuery } from '../state/use-query.js';

const runSpans: QueryRunner<SpanQuery, SpanQueryResult> = (ds, q, signal) => ds.querySpans(q, signal);

const runSpanPoints: QueryRunner<SpanPointsQuery, readonly SpanPoint[]> = (ds, q, signal) =>
  ds.spanPoints(q, signal);

/** `useQuery` over `spanPoints`: the point plot's own statement. */
export function useSpanPoints(
  dataSource: DataSource,
  query: SpanPointsQuery,
): QueryHandle<readonly SpanPoint[]> {
  return useQuery(dataSource, query, runSpanPoints);
}

/** `useQuery` over `querySpans`. */
export function useSpanQuery(dataSource: DataSource, query: SpanQuery): QueryHandle<SpanQueryResult> {
  return useQuery(dataSource, query, runSpans);
}
