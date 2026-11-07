import type { LegacyDataSource } from '../data/legacy-data-source.js';
import type { LogQuery, LogQueryResult } from '../data/log-query.js';
import { type QueryHandle, type QueryRunner, useQuery } from '../state/use-query.js';

const runLogs: QueryRunner<LogQuery, LogQueryResult> = (ds, q, onProgress, signal) =>
  ds.queryLogs(q, onProgress, signal);

/** `useQuery` over `queryLogs`: `useSpanQuery`'s twin. */
export function useLogQuery(dataSource: LegacyDataSource, query: LogQuery): QueryHandle<LogQueryResult> {
  return useQuery(dataSource, query, runLogs);
}
