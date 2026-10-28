import { type JSX, useCallback, useMemo, useState } from 'react';
import { OtelHtmlError } from '../../../model/errors.js';
import { parseUnixNanos, type SpanId, type TraceId } from '../../../model/ids.js';
import { ErrorCard, LoadingNote, NoMatch, PartialNote } from '../../components/explorer-states.js';
import { isSpanRow } from '../../components/export.js';
import { FlameGraph } from '../../components/flame-graph.js';
import { ResultsTable, type SortState } from '../../components/results-table.js';
import type { DataSource, SpanQuery, SpanRow, TraceRow } from '../../data/data-source.js';
import { useSelectionStore } from '../../state/selection-context.js';
import { useKeyedAsync } from '../../state/use-keyed-async.js';
import { useColorAssigner } from '../../theme/colors-context.js';
import { SPAN_COLUMNS_UI, TRACE_COLUMNS_UI } from '../../traces/columns.js';
import { useSpanQuery } from '../../traces/use-span-query.js';
import type { WidgetRenderer } from '../dashboard-page.js';
import { count, useSubtitle } from './subtitle.js';

/** Card header, padding and border around the body (as in the timeline widget). */
const FRAME_CHROME_PX = 52;
const MIN_PX = 96;
const LIST_SHARE = 0.6;
/** The table's own header row. */
const TABLE_HEADER_PX = 40;
const PARTIAL_NOTE_PX = 24;
const ROWS = 200;
/** The explorer's default order. */
const DEFAULT_SORT: SortState = { column: 'start', dir: 'desc' };

/** The selected trace's compact flame graph, with a way into the full panel. */
function TraceFlame(props: {
  dataSource: DataSource;
  traceId: TraceId;
  height: number;
  onOpenPanel(): void;
}): JSX.Element {
  const { dataSource, traceId } = props;
  const colors = useColorAssigner();
  const [spanId, setSpanId] = useState<SpanId | null>(null);
  const load = useCallback((id: TraceId) => dataSource.getTrace(id), [dataSource]);
  const detail = useKeyedAsync(traceId, load);
  return (
    <div className="flex flex-col gap-1 overflow-auto" style={{ height: props.height }}>
      <button
        type="button"
        onClick={props.onOpenPanel}
        className="self-end rounded-full px-2 py-0.5 text-xs text-accent hover:bg-hairline"
      >
        open trace panel →
      </button>
      {detail.status === 'loading' && <LoadingNote progress={null} />}
      {detail.status === 'error' && <ErrorCard title="Could not load the trace" message={detail.message} />}
      {detail.status === 'ready' && (
        <FlameGraph
          key={traceId}
          compact
          detail={detail.value}
          selectedSpanId={spanId}
          onSelect={setSpanId}
          colors={colors}
        />
      )}
    </div>
  );
}

/** The trace list (or span list) over the widget's scope; the followed trace's flame graph sits below it. */
export const TracesWidget: WidgetRenderer = ({ widget, scope, height, dataSource, actions }) => {
  if (widget.type !== 'traces') {
    throw new OtelHtmlError('usage', { path: 'widget.type', expected: 'traces', actual: widget.type });
  }
  const { mode, text } = widget;
  const store = useSelectionStore();
  const colors = useColorAssigner();
  const epoch = useMemo(
    () => parseUnixNanos(dataSource.manifest.epochUnixNano, 'manifest.epochUnixNano'),
    [dataSource],
  );
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const query = useMemo<SpanQuery>(
    () => ({
      condition: scope.condition,
      text,
      window: scope.window,
      mode,
      sort: { column: sort.column, dir: sort.dir },
      limit: ROWS,
      groupBy: null,
      scanAll: false,
    }),
    [scope.condition, scope.window, text, mode, sort],
  );
  const { state, scanAll } = useSpanQuery(dataSource, query);
  // Only a finished result: rows of the previous inputs are never shown as if they were current.
  const result = state.status === 'ready' ? state.result : null;

  const noun = mode === 'spans' ? 'spans' : 'traces';
  useSubtitle(
    actions,
    result === null
      ? null
      : scope.narrowed
        ? `${result.total} in selected time`
        : count(result.total, mode === 'spans' ? 'span' : 'trace'),
  );

  const spanRows: SpanRow[] = result?.rows.filter(isSpanRow) ?? [];
  const traceRows: TraceRow[] = result?.rows.filter((r): r is TraceRow => !isSpanRow(r)) ?? [];
  const followed = scope.highlightTrace;
  const partial = result?.partial ?? null;

  const body = Math.max(
    MIN_PX,
    height -
      FRAME_CHROME_PX -
      (partial === null ? 0 : PARTIAL_NOTE_PX) -
      (state.status === 'loading' ? PARTIAL_NOTE_PX : 0),
  );
  const listPx = followed === null ? body : Math.round(body * LIST_SHARE);
  const tableHeight = Math.max(MIN_PX - TABLE_HEADER_PX, listPx - TABLE_HEADER_PX);

  return (
    <div className="flex flex-col gap-1">
      {result !== null && <PartialNote partial={partial} onScanAll={scanAll} />}
      {state.status === 'loading' && <LoadingNote progress={state.progress} />}
      {state.status === 'error' && <ErrorCard title="The query could not run" message={state.message} />}
      {result !== null &&
        (result.total === 0 ? (
          <NoMatch noun={noun} />
        ) : mode === 'spans' ? (
          <ResultsTable
            rows={spanRows}
            columns={SPAN_COLUMNS_UI}
            rowId={(r) => r.span.spanId}
            sort={sort}
            onSort={setSort}
            onRowClick={(r) => actions.selectTrace(r.span.traceId)}
            moveEnabled={false}
            selectedId={spanRows.find((r) => r.span.traceId === followed)?.span.spanId ?? null}
            epoch={epoch}
            colors={colors}
            height={tableHeight}
          />
        ) : (
          <ResultsTable
            rows={traceRows}
            columns={TRACE_COLUMNS_UI}
            rowId={(r) => r.traceId}
            sort={sort}
            onSort={setSort}
            onRowClick={(r) => actions.selectTrace(r.traceId)}
            moveEnabled={false}
            selectedId={followed}
            epoch={epoch}
            colors={colors}
            height={tableHeight}
          />
        ))}
      {followed !== null && (
        <TraceFlame
          dataSource={dataSource}
          traceId={followed}
          height={body - listPx}
          onOpenPanel={() => store.getState().selectTrace(followed)}
        />
      )}
    </div>
  );
};
