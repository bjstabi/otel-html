import { type JSX, useMemo, useState } from 'react';
import type { UnixNanos } from '../../model/ids.js';
import type { LogRef, LogRow } from '../data/log-query.js';
import { logAttributeColumn, logColumns } from '../logs/columns.js';
import { ResultsTable, type SortState } from './results-table.js';

const LINE_OPTIONS = [1, 3, 10] as const;

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
}): JSX.Element {
  const [lines, setLines] = useState<number>(1);
  const extra = props.extraColumns;
  const columns = useMemo(
    () => [...logColumns(lines), ...(extra ?? []).map(logAttributeColumn)],
    [lines, extra],
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
        {...(props.height === undefined ? {} : { height: props.height })}
        {...(props.moveEnabled === undefined ? {} : { moveEnabled: props.moveEnabled })}
      />
    </div>
  );
}
