import { CircleAlert } from 'lucide-react';
import { type JSX, useMemo, useState } from 'react';
import { anyValueToDisplay } from '../../model/anyvalue.js';
import type { SpanId, UnixNanos } from '../../model/ids.js';
import { type ResourceRecord, StatusCode } from '../../model/records.js';
import { formatDuration } from '../../semconv/formatters.js';
import { ResultsTable, type SortState } from '../components/results-table.js';
import type { DataSource, TraceDetail } from '../data/data-source.js';
import type { SpanRow } from '../data/span-query.js';
import { exclusiveTimeByService } from '../data/trace-tree.js';
import { gridWindow, MetricGrid, type MetricGridOrigin } from '../metrics/metric-grid.js';
import type { ColorAssigner } from '../theme/palette.js';
import { ServiceChip, SPAN_COLUMNS_UI } from './columns.js';
import { traceFacts } from './trace-facts.js';

const TH = 'p-2 text-left text-xs font-semibold text-ink-2';

/** Per-service table: spans, errors, exclusive time and its share (no node map in v1). */
export function ServicesTab(props: { detail: TraceDetail; colors: ColorAssigner }): JSX.Element {
  const rows = useMemo(() => {
    const exclusive = exclusiveTimeByService(props.detail.tree);
    const total = exclusive.reduce((a, e) => a + e.ns, 0);
    return exclusive.map((e) => {
      const own = props.detail.spans.filter((r) => r.service === e.service);
      return {
        service: e.service,
        spans: own.length,
        errors: own.filter((r) => r.span.status.code === StatusCode.ERROR).length,
        ns: e.ns,
        share: total === 0 ? null : e.ns / total,
      };
    });
  }, [props.detail]);
  return (
    <table aria-label="Services in this trace" className="w-full text-sm">
      <thead>
        <tr className="border-b border-hairline">
          <th scope="col" className={TH}>
            Service
          </th>
          <th scope="col" className={`${TH} text-right`}>
            Spans
          </th>
          <th scope="col" className={`${TH} text-right`}>
            Errors
          </th>
          <th scope="col" className={`${TH} text-right`}>
            Exclusive time
          </th>
          <th scope="col" className={`${TH} text-right`}>
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.service} className="border-b border-hairline last:border-0">
            <td className="p-2">
              <ServiceChip service={r.service} colors={props.colors} />
            </td>
            <td className="p-2 text-right font-mono tabular-nums">{r.spans}</td>
            <td className="p-2 text-right font-mono tabular-nums">{r.errors}</td>
            <td className="p-2 text-right font-mono tabular-nums">{formatDuration(r.ns)}</td>
            <td className="p-2 text-right font-mono tabular-nums">
              {r.share === null ? '-' : `${(r.share * 100).toFixed(1)}%`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function exceptionText(r: SpanRow): string | null {
  const parts: string[] = [];
  for (const e of r.span.events) {
    if (e.name !== 'exception') continue;
    const type = e.attributes.get('exception.type');
    const message = e.attributes.get('exception.message');
    const text = [type, message]
      .filter((v) => v !== undefined)
      .map((v) => anyValueToDisplay(v))
      .join(': ');
    parts.push(text === '' ? 'exception' : text);
  }
  return parts.length === 0 ? null : parts.join('; ');
}

/** Spans with an error status or an exception event, in start order. Text only: messages are never markup. */
export function ErrorsTab(props: {
  detail: TraceDetail;
  selectedSpanId: SpanId | null;
  onSelect(id: SpanId): void;
  colors: ColorAssigner;
}): JSX.Element {
  const { detail } = props;
  const rows = detail.spans
    .filter((r) => r.span.status.code === StatusCode.ERROR || exceptionText(r) !== null)
    .sort((a, b) => a.span.start - b.span.start);
  const origin = detail.tree.roots[0]?.row.span.start ?? 0;
  return (
    <table aria-label="Errors in this trace" className="w-full text-sm">
      <thead>
        <tr className="border-b border-hairline">
          <th scope="col" className={TH}>
            At
          </th>
          <th scope="col" className={TH}>
            Service
          </th>
          <th scope="col" className={TH}>
            Span
          </th>
          <th scope="col" className={TH}>
            Error
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const selected = r.span.spanId === props.selectedSpanId;
          const message = r.span.status.message;
          return (
            <tr
              key={r.span.spanId}
              data-selected={selected ? 'true' : undefined}
              className={`border-b border-hairline last:border-0 ${selected ? 'bg-ink text-surface' : ''}`}
            >
              <td className="p-2 font-mono text-xs tabular-nums">+{formatDuration(r.span.start - origin)}</td>
              <td className="p-2">
                <ServiceChip service={r.service} colors={props.colors} />
              </td>
              <td className="p-2">
                <button
                  type="button"
                  onClick={() => props.onSelect(r.span.spanId)}
                  className="rounded-full px-2 py-0.5 text-left underline hover:bg-hairline/60"
                >
                  {r.span.name}
                </button>
              </td>
              <td className="p-2">
                <span className="inline-flex items-center gap-1 font-semibold">
                  <CircleAlert size={13} aria-hidden />
                  {r.span.status.code === StatusCode.ERROR ? 'error' : 'exception'}
                </span>
                {message !== '' && <span className="ml-2 font-mono text-xs break-words">{message}</span>}
                {exceptionText(r) !== null && (
                  <span className="ml-2 font-mono text-xs break-words">{exceptionText(r)}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const byStart = (a: SpanRow, b: SpanRow): number => a.span.start - b.span.start;
const SORTERS: Record<string, (a: SpanRow, b: SpanRow) => number> = {
  start: byStart,
  status: (a, b) => a.span.status.code - b.span.status.code,
  service: (a, b) => a.service.localeCompare(b.service),
  name: (a, b) => a.span.name.localeCompare(b.span.name),
  resource: (a, b) => a.resource.localeCompare(b.resource),
  duration: (a, b) => a.durationNs - b.durationNs,
};

/** Flat sortable list of the trace's spans (sorted here: the whole trace is already in memory). */
export function SpanListTab(props: {
  detail: TraceDetail;
  selectedSpanId: SpanId | null;
  onSelect(id: SpanId): void;
  epoch: UnixNanos;
  colors: ColorAssigner;
}): JSX.Element {
  const [sort, setSort] = useState<SortState>({ column: 'start', dir: 'asc' });
  const rows = useMemo(() => {
    const cmp = SORTERS[sort.column] ?? byStart;
    return [...props.detail.spans].sort((a, b) => cmp(a, b) * (sort.dir === 'asc' ? 1 : -1));
  }, [props.detail, sort]);
  return (
    <ResultsTable
      rows={rows}
      columns={SPAN_COLUMNS_UI}
      rowId={(r) => r.span.spanId}
      sort={sort}
      onSort={setSort}
      onRowClick={(r) => props.onSelect(r.span.spanId)}
      selectedId={props.selectedSpanId}
      epoch={props.epoch}
      colors={props.colors}
      height={360}
      moveEnabled={false}
    />
  );
}

/** The resources of a trace's spans, one record per distinct ref. */
export function traceResources(detail: TraceDetail): ResourceRecord[] {
  const refs = [...new Set(detail.spans.map((r) => r.span.resource))];
  return refs.map((r) => detail.resources(r));
}

/** The embedded metric grid on the trace's resources (one line per resource), over the trace ± 5 min. */
export function TraceMetricsTab(props: {
  detail: TraceDetail;
  resources: readonly ResourceRecord[];
  dataSource: DataSource;
}): JSX.Element {
  const { detail, resources, dataSource } = props;
  const range = dataSource.manifest.range;
  const origin = useMemo((): MetricGridOrigin => {
    const f = traceFacts(detail);
    return {
      kind: 'trace',
      resources,
      at: f.start,
      window: gridWindow({ start: f.start, end: f.end }, range),
      traceId: detail.traceId,
    };
  }, [detail, resources, range]);
  return <MetricGrid key={detail.traceId} dataSource={dataSource} origin={origin} />;
}
