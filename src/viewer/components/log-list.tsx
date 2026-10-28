import { type JSX, useMemo, useState } from 'react';
import type { TraceId, UnixNanos } from '../../model/ids.js';
import type { LogRef, LogRow } from '../data/log-query.js';
import { logAttributeColumn, logColumns, type TraceCheck } from '../logs/columns.js';
import { ResultsTable, type SortState } from './results-table.js';

const LINE_OPTIONS = [1, 3, 10] as const;

/** One lookup per trace id for the list's lifetime; a failed lookup is dropped so a later render retries it. */
function cachedCheck(check: TraceCheck): TraceCheck {
  const seen = new Map<TraceId, Promise<boolean>>();
  return (id) => {
    let p = seen.get(id);
    if (p === undefined) {
      p = Promise.resolve()
        .then(() => check(id))
        .catch((e: unknown) => {
          seen.delete(id);
          throw e;
        });
      seen.set(id, p);
    }
    return p;
  };
}

/** The one log list: Explorer, Surrounding logs and the trace and span Logs tabs all render this. */
export function LogList(props: {
  rows: readonly LogRow[];
  total?: number;
  sort: SortState | null;
  onSort(next: SortState): void;
  onRowClick(row: LogRow): void;
  selectedRef: LogRef | null;
  epoch: UnixNanos;
  extraColumns?: readonly string[];
  moveEnabled?: boolean;
  height?: number;
  /** Whether the report holds a trace; with it, a trace id the report lacks is shown as text, not a link. */
  hasTrace?: TraceCheck;
  /** Refs to mark as matches (accent rule, `data-match`); with the set given, the other rows are muted. */
  highlighted?: ReadonlySet<string>;
}): JSX.Element {
  const [lines, setLines] = useState<number>(1);
  const { extraColumns: extra, hasTrace, highlighted } = props;
  const check = useMemo(() => (hasTrace === undefined ? undefined : cachedCheck(hasTrace)), [hasTrace]);
  const columns = useMemo(
    () => [...logColumns(lines, check), ...(extra ?? []).map(logAttributeColumn)],
    [lines, check, extra],
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-sm text-ink-2">
        <label className="flex items-center gap-2">
          Lines
          <select
            value={lines}
            onChange={(e) => setLines(Number(e.target.value))}
            className="rounded-full border border-hairline bg-surface px-3 py-1 text-sm"
          >
            {LINE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {props.total === undefined ? null : (
          <span className="text-xs text-muted">
            {props.rows.length} of {props.total}
          </span>
        )}
      </div>
      <ResultsTable
        rows={props.rows}
        columns={columns}
        rowId={(r) => r.ref}
        sort={props.sort}
        onSort={props.onSort}
        onRowClick={props.onRowClick}
        selectedId={props.selectedRef}
        epoch={props.epoch}
        rowHeight={20 * lines + 16}
        {...(highlighted === undefined
          ? {}
          : { rowMark: (r: LogRow) => (highlighted.has(r.ref) ? ('match' as const) : ('muted' as const)) })}
        {...(props.height === undefined ? {} : { height: props.height })}
        {...(props.moveEnabled === undefined ? {} : { moveEnabled: props.moveEnabled })}
      />
    </div>
  );
}
