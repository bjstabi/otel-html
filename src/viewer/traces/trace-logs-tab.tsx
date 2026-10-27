import { ExternalLink } from 'lucide-react';
import { type JSX, useEffect, useMemo, useState } from 'react';
import { OtelHtmlError } from '../../model/errors.js';
import type { SpanId, TraceId, UnixNanos } from '../../model/ids.js';
import { LogList } from '../components/log-list.js';
import type { SortState } from '../components/results-table.js';
import type { DataSource } from '../data/data-source.js';
import { byTimeThenRef, LOG_SORTS, type LogRow } from '../data/log-query.js';
import { useGoTo } from '../shell/go-to.js';
import { CONTROL } from '../shell/page-chrome.js';

export type TraceLogsState = { rows: readonly LogRow[]; error: null } | { rows: null; error: string | null };

/**
 * The trace's logs, time-ascending, loaded once per open trace (when it has any) and shared by the trace Logs tab
 * and the span Logs tab. `rows` is null while loading or after a failed load (then `error` is set).
 */
export function useTraceLogs(dataSource: DataSource, traceId: TraceId, enabled: boolean): TraceLogsState {
  const [state, setState] = useState<{ traceId: TraceId; value: TraceLogsState } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    Promise.resolve()
      .then(() => dataSource.traceLogs(traceId, ctl.signal))
      .then(
        (rows) => ctl.signal.aborted || setState({ traceId, value: { rows, error: null } }),
        (e: unknown) =>
          ctl.signal.aborted ||
          setState({
            traceId,
            value: {
              rows: null,
              error: e instanceof OtelHtmlError ? e.message : e instanceof Error ? e.message : String(e),
            },
          }),
      );
    return () => ctl.abort();
  }, [dataSource, traceId, enabled]);
  return enabled && state !== null && state.traceId === traceId ? state.value : { rows: null, error: null };
}

/** The `trace_id` (and `span_id`) condition that selects exactly these logs in the Logs Explorer. */
export function logScopeQuery(scope: { traceId: TraceId; spanId?: SpanId }): string {
  const trace = `trace_id.string == "${scope.traceId}"`;
  return scope.spanId === undefined ? trace : `${trace} and span_id.string == "${scope.spanId}"`;
}

function sorted(rows: readonly LogRow[], sort: SortState): readonly LogRow[] {
  const by = LOG_SORTS[sort.column] ?? LOG_SORTS.time;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * by(a, b) || byTimeThenRef(a, b));
}

/** Logs of the open trace, or of one span in it: the shared `LogList`, a count and a jump to the Logs Explorer. */
export function TraceLogsTab(props: {
  rows: readonly LogRow[];
  scope: { traceId: TraceId } | { traceId: TraceId; spanId: SpanId };
  epoch: UnixNanos;
}): JSX.Element {
  const { rows, scope, epoch } = props;
  const goTo = useGoTo();
  const [sort, setSort] = useState<SortState>({ column: 'time', dir: 'asc' });
  const shown = useMemo(() => sorted(rows, sort), [rows, sort]);
  const q = logScopeQuery(scope);
  const testId = 'spanId' in scope ? 'span-logs-tab' : 'trace-logs-tab';
  return (
    <div data-testid={testId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-sm text-ink-2">
          {rows.length} {rows.length === 1 ? 'log' : 'logs'}
        </p>
        <button type="button" className={CONTROL} onClick={() => goTo('logs', '/logs', { q })}>
          <ExternalLink size={16} aria-hidden />
          Open in Logs Explorer
        </button>
      </div>
      <LogList
        rows={shown}
        sort={sort}
        onSort={setSort}
        onRowClick={(r) => goTo('logs', '/logs', { q, log: r.ref, ltab: 'attributes' })}
        selectedRef={null}
        epoch={epoch}
        moveEnabled={false}
        height={280}
      />
    </div>
  );
}
