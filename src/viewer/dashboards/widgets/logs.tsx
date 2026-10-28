import { type JSX, useMemo, useState } from 'react';
import { andConditions } from '../../../dashboards/conditions.js';
import { OtelHtmlError } from '../../../model/errors.js';
import { parseUnixNanos } from '../../../model/ids.js';
import { ErrorCard, LoadingNote, NoMatch, PartialNote } from '../../components/explorer-states.js';
import { LogList } from '../../components/log-list.js';
import type { SortState } from '../../components/results-table.js';
import type { DataSource } from '../../data/data-source.js';
import type { LogQuery, LogQueryResult, LogRow } from '../../data/log-query.js';
import { useLogQuery } from '../../logs/use-log-query.js';
import { useSelection, useSelectionStore } from '../../state/selection-context.js';
import type { QueryHandle } from '../../state/use-query.js';
import type { WidgetRenderer } from '../dashboard-page.js';
import { variableCondition } from '../scope.js';
import { useSubtitle } from './subtitle.js';

/** Card header, padding and border, then the view toggle and the list's own control row. */
const FRAME_CHROME_PX = 52;
const TOGGLE_PX = 32;
const LIST_CONTROLS_PX = 36;
const TABLE_HEADER_PX = 40;
const NOTE_PX = 24;
const MIN_PX = 96;
const ROWS = 200;

type LogsResult = Extract<LogQueryResult, { mode: 'logs' }>;

function logsOf(h: QueryHandle<LogQueryResult>): LogsResult | null {
  const r =
    h.state.status === 'ready' ? h.state.result : h.state.status === 'loading' ? h.state.previous : null;
  return r !== null && r.mode === 'logs' ? r : null;
}

const VIEWS = [
  { id: 'matches', label: 'Only matches' },
  { id: 'context', label: 'Show context' },
] as const;

function ViewToggle(props: {
  view: 'matches' | 'context';
  onChange(v: 'matches' | 'context'): void;
}): JSX.Element {
  return (
    <fieldset className="flex items-center gap-1 self-start rounded-full border border-hairline p-0.5">
      <legend className="sr-only">Log view</legend>
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          aria-pressed={props.view === v.id}
          onClick={() => props.onChange(v.id)}
          className={`rounded-full px-2.5 py-0.5 text-xs ${
            props.view === v.id ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-hairline'
          }`}
        >
          {v.label}
        </button>
      ))}
    </fieldset>
  );
}

function logQuery(
  window: LogQuery['window'],
  condition: string | null,
  text: string,
  sort: SortState,
): LogQuery {
  return {
    condition,
    text,
    window,
    mode: 'logs',
    sort: { column: sort.column, dir: sort.dir },
    limit: ROWS,
    scanAll: false,
  };
}

/** The list over a query's logs; the notes and states of the explorers sit above it. */
function ListBody(props: {
  dataSource: DataSource;
  handle: QueryHandle<LogQueryResult>;
  shown: LogsResult | null;
  highlighted?: ReadonlySet<string>;
  sort: SortState;
  onSort(s: SortState): void;
  height: number;
}): JSX.Element {
  const { dataSource, handle, shown } = props;
  const store = useSelectionStore();
  const logRef = useSelection((s) => s.logRef);
  const epoch = useMemo(
    () => parseUnixNanos(dataSource.manifest.epochUnixNano, 'manifest.epochUnixNano'),
    [dataSource],
  );
  const { state } = handle;
  return (
    <div className="flex flex-col gap-1">
      {shown !== null && <PartialNote partial={shown.partial} onScanAll={handle.scanAll} />}
      {state.status === 'loading' && <LoadingNote progress={state.progress} />}
      {state.status === 'error' && <ErrorCard title="The query could not run" message={state.message} />}
      {shown !== null &&
        (shown.total === 0 ? (
          <NoMatch noun="logs" />
        ) : (
          <LogList
            rows={shown.rows}
            total={shown.total}
            sort={props.sort}
            onSort={props.onSort}
            onRowClick={(r: LogRow) => store.getState().selectLog(r.ref)}
            selectedRef={logRef}
            epoch={epoch}
            moveEnabled={false}
            height={props.height}
            hasTrace={dataSource.hasTrace}
            {...(props.highlighted === undefined ? {} : { highlighted: props.highlighted })}
          />
        ))}
    </div>
  );
}

/** Every log in the window (the variables still apply), with the matches marked. */
function ContextView(props: {
  dataSource: DataSource;
  context: LogQuery;
  matched: LogsResult | null;
  sort: SortState;
  onSort(s: SortState): void;
  height: number;
}): JSX.Element {
  const handle = useLogQuery(props.dataSource, props.context);
  const { matched } = props;
  const highlighted = useMemo(
    () => (matched === null ? undefined : new Set<string>(matched.rows.map((r) => r.ref))),
    [matched],
  );
  return (
    <ListBody
      dataSource={props.dataSource}
      handle={handle}
      shown={logsOf(handle)}
      sort={props.sort}
      onSort={props.onSort}
      height={props.height}
      {...(highlighted === undefined ? {} : { highlighted })}
    />
  );
}

/** The log list over the widget's scope; it follows the selected trace and can show the surrounding logs. */
export const LogsWidget: WidgetRenderer = ({
  widget,
  scope,
  height,
  dataSource,
  actions,
  variables,
  state,
}) => {
  if (widget.type !== 'logs') {
    throw new OtelHtmlError('usage', { path: 'widget.type', expected: 'logs', actual: widget.type });
  }
  const { text } = widget;
  const view = state.logView[widget.id] ?? (widget.context ? 'context' : 'matches');
  const [sort, setSort] = useState<SortState>({ column: 'time', dir: 'desc' });
  const contextCondition = useMemo(() => andConditions(variableCondition(variables, 'log')), [variables]);
  const matches = useMemo(
    () => logQuery(scope.window, scope.condition, text, sort),
    [scope.window, scope.condition, text, sort],
  );
  const context = useMemo(
    () => logQuery(scope.window, contextCondition, '', sort),
    [scope.window, contextCondition, sort],
  );
  const handle = useLogQuery(dataSource, matches);
  const matched = logsOf(handle);
  useSubtitle(
    actions,
    matched === null
      ? null
      : scope.traceFilter !== null
        ? `${matched.total} for the selected trace`
        : scope.narrowed
          ? `${matched.total} in selected time`
          : `${matched.total} logs`,
  );
  const listPx =
    Math.max(MIN_PX, height - FRAME_CHROME_PX - TOGGLE_PX - LIST_CONTROLS_PX - NOTE_PX) - TABLE_HEADER_PX;
  const list = { dataSource, sort, onSort: setSort, height: Math.max(48, listPx) };
  return (
    <div className="flex flex-col gap-1">
      <ViewToggle view={view} onChange={actions.setLogView} />
      {view === 'context' ? (
        <ContextView {...list} context={context} matched={matched} />
      ) : (
        <ListBody {...list} handle={handle} shown={matched} />
      )}
    </div>
  );
};
