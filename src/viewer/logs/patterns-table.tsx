import type { JSX } from 'react';
import type { UnixNanos } from '../../model/ids.js';
import { SEVERITY_SERIES } from '../components/histogram-card.js';
import { ResultsTable, type SortState } from '../components/results-table.js';
import type { PatternRow } from '../data/log-query.js';
import { absoluteTime } from '../shell/time-range.js';
import type { ColumnUi } from '../traces/columns.js';

/** A pattern's severity mix: a stacked bar, repeated as labelled counts so colour is never the only cue. */
function SeverityStack(props: { row: PatternRow }): JSX.Element {
  const present = SEVERITY_SERIES.series.filter((s) => props.row.severities[s.key] > 0);
  const total = props.row.count;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden className="flex h-2 w-16 shrink-0 overflow-hidden rounded-full bg-hairline">
        {present.map((s) => (
          <span
            key={s.key}
            style={{
              background: s.color,
              width: `${total === 0 ? 0 : (props.row.severities[s.key] / total) * 100}%`,
            }}
          />
        ))}
      </span>
      <span className="truncate text-xs text-ink-2">
        {present.map((s) => `${s.label} ${props.row.severities[s.key]}`).join(' · ')}
      </span>
    </span>
  );
}

export const PATTERN_COLUMNS_UI: readonly ColumnUi<PatternRow>[] = [
  {
    id: 'template',
    header: 'Template',
    width: 420,
    mono: true,
    cell: (r) => (
      <span className="block truncate" title={r.sample}>
        {r.template}
      </span>
    ),
  },
  { id: 'count', header: 'Count', sort: 'count', width: 80, mono: true, cell: (r) => r.count },
  { id: 'severity', header: 'Severity', width: 200, cell: (r) => <SeverityStack row={r} /> },
  {
    id: 'first',
    header: 'First',
    sort: 'first',
    width: 170,
    mono: true,
    cell: (r, c) => absoluteTime(r.first, c.epoch),
  },
  {
    id: 'last',
    header: 'Last',
    sort: 'last',
    width: 170,
    mono: true,
    cell: (r, c) => absoluteTime(r.last, c.epoch),
  },
];

/** Patterns mode: one row per Drain cluster. A click turns the template into a filter (the explorer's call). */
export function PatternsTable(props: {
  rows: readonly PatternRow[];
  sort: SortState;
  onSort(next: SortState): void;
  onRowClick(row: PatternRow): void;
  epoch: UnixNanos;
  moveEnabled: boolean;
}): JSX.Element {
  return (
    <ResultsTable
      rows={props.rows}
      columns={PATTERN_COLUMNS_UI}
      rowId={(r) => String(r.id)}
      sort={props.sort}
      onSort={props.onSort}
      onRowClick={props.onRowClick}
      selectedId={null}
      epoch={props.epoch}
      moveEnabled={props.moveEnabled}
    />
  );
}
