import { Link2 } from 'lucide-react';
import type { JSX } from 'react';
import { anyValueToDisplay } from '../../model/anyvalue.js';
import { LogBody } from '../components/log-body.js';
import { SeverityBadge } from '../components/severity.js';
import type { LogRow } from '../data/log-query.js';
import { absoluteTime } from '../shell/time-range.js';
import { type ColumnUi, ServiceChip } from '../traces/columns.js';

const dash = <span className="text-muted">-</span>;

function TraceLink(props: { row: LogRow }): JSX.Element {
  const id = props.row.log.traceId;
  if (id === null) return dash;
  return (
    <a
      href={`#/traces/trace/${id}`}
      aria-label="trace"
      title="Open trace"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex rounded-full p-1 text-ink-2 hover:bg-hairline"
    >
      <Link2 size={14} aria-hidden />
    </a>
  );
}

/** The log columns for a body clamped to `lines` lines. */
export function logColumns(lines: number): readonly ColumnUi<LogRow>[] {
  return [
    {
      id: 'time',
      header: 'Time',
      sort: 'time',
      width: 190,
      mono: true,
      cell: (r, c) =>
        r.timeSource === 'none' ? (
          <span className="text-muted">no timestamp</span>
        ) : r.timeSource === 'observed' ? (
          <span>
            {absoluteTime(r.time, c.epoch)}
            <sup className="ml-1 text-muted">observed</sup>
          </span>
        ) : (
          absoluteTime(r.time, c.epoch)
        ),
    },
    {
      id: 'severity',
      header: 'Severity',
      sort: 'severity',
      width: 130,
      cell: (r) => <SeverityBadge number={r.log.severityNumber} text={r.log.severityText} />,
    },
    {
      id: 'service',
      header: 'Service',
      sort: 'service',
      width: 130,
      cell: (r, c) => <ServiceChip service={r.service} colors={c.colors} />,
    },
    { id: 'host', header: 'Host', width: 110, mono: true, cell: (r) => r.host ?? dash },
    {
      id: 'body',
      header: 'Body',
      width: 480,
      cell: (r) => <LogBody body={r.log.body} mode="wrapped" lines={lines} />,
    },
    { id: 'trace', header: 'Trace', width: 60, cell: (r) => <TraceLink row={r} /> },
  ];
}

export const LOG_COLUMNS_UI: readonly ColumnUi<LogRow>[] = logColumns(1);

/** The column picker's attribute column: the log attribute's value, as monospace text. */
export function logAttributeColumn(key: string): ColumnUi<LogRow> {
  return {
    id: `attr:${key}`,
    header: key,
    width: 160,
    mono: true,
    cell: (r) => {
      const v = r.log.attributes.get(key);
      return v === undefined ? dash : anyValueToDisplay(v);
    },
  };
}
