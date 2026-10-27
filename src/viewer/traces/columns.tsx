import type { JSX, ReactNode } from 'react';
import { anyValueToDisplay } from '../../model/anyvalue.js';
import type { UnixNanos } from '../../model/ids.js';
import { StatusCode } from '../../model/records.js';
import { formatDuration } from '../../semconv/formatters.js';
import type { SpanRow, TraceRow } from '../data/span-query.js';
import { absoluteTime } from '../shell/time-range.js';
import type { ColorAssigner } from '../theme/palette.js';
import { OTHER_INDEX } from '../theme/palette.js';

export interface CellContext {
  epoch: UnixNanos;
  colors: ColorAssigner;
}

/** A results-table column as data: the table renders whatever it is given. `sort` is the data layer's sort column. */
export interface ColumnUi<R> {
  id: string;
  header: string;
  cell(row: R, ctx: CellContext): ReactNode;
  sort?: string;
  /** Pixel width basis; columns share the row proportionally. */
  width: number;
  /** Monospace tabular numerals: times, durations, ids, attribute keys and values. */
  mono?: boolean;
}

const seriesVar = (i: number): string =>
  i >= OTHER_INDEX ? 'var(--oh-series-other)' : `var(--oh-series-${i + 1})`;

/** Labelled status dot: the label carries the meaning, the colour only repeats it. */
export function StatusDot(props: { error: boolean; label: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block size-2 rounded-full"
        style={{
          background: props.error ? 'var(--oh-critical)' : 'var(--oh-series-3)',
          // A diamond mark for errors so the shape differs, not just the hue.
          transform: props.error ? 'rotate(45deg)' : undefined,
          borderRadius: props.error ? '1px' : undefined,
        }}
      />
      <span className={props.error ? 'text-critical' : 'text-ink-2'}>{props.label}</span>
    </span>
  );
}

export function ServiceChip(props: { service: string; colors: ColorAssigner }): JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block size-2.5 shrink-0 rounded-sm"
        style={{ background: seriesVar(props.colors.colorFor(props.service)) }}
      />
      <span className="truncate">{props.service}</span>
    </span>
  );
}

function statusLabel(code: StatusCode): { label: string; error: boolean } {
  switch (code) {
    case StatusCode.ERROR:
      return { label: 'error', error: true };
    case StatusCode.OK:
      return { label: 'ok', error: false };
    default:
      return { label: 'unset', error: false };
  }
}

function attrText(r: SpanRow, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = r.span.attributes.get(k);
    if (v !== undefined) return anyValueToDisplay(v);
  }
  return null;
}

const CODE_CLASS: Record<string, string> = {
  '2': 'bg-ink/5 text-ink-2',
  '3': 'bg-ink/5 text-ink-2',
  '4': 'bg-warning/25 text-ink',
  '5': 'bg-critical/15 text-critical',
};

/** Class-tinted pill ("2xx" family in the tooltip, the code itself as text). */
export function CodePill({ code }: { code: string }): JSX.Element {
  const family = code.slice(0, 1);
  return (
    <span
      title={`${family}xx`}
      className={`rounded-full px-2 py-0.5 font-mono text-xs tabular-nums ${CODE_CLASS[family] ?? 'bg-ink/5 text-ink-2'}`}
    >
      {code}
    </span>
  );
}

const dash = <span className="text-muted">-</span>;

export const SPAN_COLUMNS_UI: readonly ColumnUi<SpanRow>[] = [
  {
    id: 'time',
    header: 'Time',
    sort: 'start',
    width: 200,
    mono: true,
    cell: (r, c) => absoluteTime(r.span.start, c.epoch),
  },
  {
    id: 'status',
    header: 'Status',
    sort: 'status',
    width: 90,
    cell: (r) => {
      const s = statusLabel(r.span.status.code);
      return <StatusDot {...s} />;
    },
  },
  {
    id: 'service',
    header: 'Service',
    sort: 'service',
    width: 140,
    cell: (r, c) => <ServiceChip service={r.service} colors={c.colors} />,
  },
  { id: 'name', header: 'Span', sort: 'name', width: 200, cell: (r) => r.span.name },
  { id: 'resource', header: 'Resource', sort: 'resource', width: 200, cell: (r) => r.resource },
  {
    id: 'duration',
    header: 'Duration',
    sort: 'duration',
    width: 100,
    mono: true,
    cell: (r) => formatDuration(r.durationNs),
  },
  {
    id: 'method',
    header: 'Method',
    width: 80,
    mono: true,
    cell: (r) => attrText(r, 'http.request.method', 'http.method') ?? dash,
  },
  {
    id: 'code',
    header: 'Code',
    width: 70,
    cell: (r) => {
      const code = attrText(r, 'http.response.status_code', 'http.status_code');
      return code === null ? dash : <CodePill code={code} />;
    },
  },
];

/** Stacked bar of exclusive time per service; a labelled "partial" cell when the share is not whole-trace. */
function ServiceShare({ row, colors }: { row: TraceRow; colors: ColorAssigner }): JSX.Element {
  if (!row.shareComplete) {
    return (
      <span
        className="text-xs text-muted"
        title="Only part of this trace was scanned, so the split is unknown"
      >
        partial
      </span>
    );
  }
  const total = row.serviceShare.reduce((a, s) => a + s.ns, 0);
  if (total === 0) return dash;
  return (
    <span
      role="img"
      aria-label={row.serviceShare.map((s) => `${s.service} ${formatDuration(s.ns)}`).join(', ')}
      className="flex h-2.5 w-full overflow-hidden rounded-sm bg-hairline"
    >
      {row.serviceShare.map((s) => (
        <span
          key={s.service}
          title={`${s.service}: ${formatDuration(s.ns)}`}
          style={{ width: `${(s.ns / total) * 100}%`, background: seriesVar(colors.colorFor(s.service)) }}
        />
      ))}
    </span>
  );
}

export const TRACE_COLUMNS_UI: readonly ColumnUi<TraceRow>[] = [
  {
    id: 'time',
    header: 'Time',
    sort: 'start',
    width: 200,
    mono: true,
    cell: (r, c) => absoluteTime(r.start, c.epoch),
  },
  {
    id: 'status',
    header: 'Status',
    sort: 'errors',
    width: 110,
    cell: (r) => <StatusDot error={r.errors > 0} label={r.errors > 0 ? `${r.errors} errors` : 'ok'} />,
  },
  {
    id: 'service',
    header: 'Service',
    sort: 'service',
    width: 140,
    cell: (r, c) => {
      const s = r.root?.service ?? r.rootSummary?.service;
      return s === undefined ? dash : <ServiceChip service={s} colors={c.colors} />;
    },
  },
  {
    id: 'resource',
    header: 'Resource',
    sort: 'resource',
    width: 220,
    cell: (r) => r.root?.resource ?? r.rootSummary?.resource ?? dash,
  },
  {
    id: 'duration',
    header: 'Duration',
    sort: 'duration',
    width: 100,
    mono: true,
    cell: (r) => formatDuration(r.durationNs),
  },
  { id: 'spans', header: 'Spans', sort: 'spans', width: 70, mono: true, cell: (r) => r.spans },
  {
    id: 'share',
    header: 'Latency by service',
    width: 200,
    cell: (r, c) => <ServiceShare row={r} colors={c.colors} />,
  },
];

/** The column picker's attribute column: the span attribute's value, as monospace text. */
export function attributeColumn(key: string): ColumnUi<SpanRow> {
  return {
    id: `attr:${key}`,
    header: key,
    width: 160,
    mono: true,
    cell: (r) => attrText(r, key) ?? dash,
  };
}
