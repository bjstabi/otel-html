import type { LegacyDataSource } from '../data/legacy-data-source.js';
import type { LogQuery, LogQueryResult } from '../data/log-query.js';
import { type LegacyQueryHandle, type LegacyQueryRunner, useLegacyQuery } from '../state/legacy-use-query.js';

const runLogs: LegacyQueryRunner<LogQuery, LogQueryResult> = (ds, q, onProgress, signal) =>
  ds.queryLogs(q, onProgress, signal);

/** The dashboards' log query (legacy scan shapes), until 5.4 moves them to `useLogsPage`. */
export function useLegacyLogQuery(
  dataSource: LegacyDataSource,
  query: LogQuery,
): LegacyQueryHandle<LogQueryResult> {
  return useLegacyQuery(dataSource, query, runLogs);
}
