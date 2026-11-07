import type { LegacyDataSource } from '../data/legacy-data-source.js';
import type { LogQuery, LogQueryResult } from '../data/log-query.js';
import { type LegacyQueryHandle, type LegacyQueryRunner, useLegacyQuery } from '../state/legacy-use-query.js';

const runLogs: LegacyQueryRunner<LogQuery, LogQueryResult> = (ds, q, onProgress, signal) =>
  ds.queryLogs(q, onProgress, signal);

/** `useLegacyQuery` over `queryLogs`: `useSpanQuery`'s twin. */
export function useLogQuery(
  dataSource: LegacyDataSource,
  query: LogQuery,
): LegacyQueryHandle<LogQueryResult> {
  return useLegacyQuery(dataSource, query, runLogs);
}
