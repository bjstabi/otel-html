import type { DataSource } from '../data/data-source.js';
import type { LogQuery, LogQueryResult, PatternQuery, PatternsResult } from '../data/results.js';
import { type QueryHandle, type QueryRunner, useQuery } from '../state/use-query.js';

/** What the Logs page asks: rows (logs or traces mode) through `queryLogs`, or the patterns (D9). */
export type LogsPageQuery = { kind: 'rows'; query: LogQuery } | { kind: 'patterns'; query: PatternQuery };

export type LogsPageResult =
  | { kind: 'rows'; result: LogQueryResult }
  | { kind: 'patterns'; result: PatternsResult };

const runLogsPage: QueryRunner<LogsPageQuery, LogsPageResult> = async (ds: DataSource, q, signal) =>
  q.kind === 'rows'
    ? { kind: 'rows', result: await ds.queryLogs(q.query, signal) }
    : { kind: 'patterns', result: await ds.patterns(q.query, signal) };

/** `useQuery` over `queryLogs` or `patterns`, by the query's kind. */
export function useLogsPage(dataSource: DataSource, query: LogsPageQuery): QueryHandle<LogsPageResult> {
  return useQuery(dataSource, query, runLogsPage);
}
