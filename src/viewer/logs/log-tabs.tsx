import { type JSX, useCallback, useMemo, useState } from 'react';
import type { SpanId, TraceId, UnixNanos } from '../../model/ids.js';
import { formatDuration } from '../../semconv/formatters.js';
import { AttributeGroups } from '../components/attribute-groups.js';
import { FlameGraph } from '../components/flame-graph.js';
import { LogList } from '../components/log-list.js';
import { ResourceTab } from '../components/resource-tab.js';
import { useFilterActions } from '../components/use-filter-actions.js';
import { Waterfall } from '../components/waterfall.js';
import type { DataSource } from '../data/data-source.js';
import type { LogRef, LogRow } from '../data/log-query.js';
import { useGoTo } from '../shell/go-to.js';
import { CONTROL } from '../shell/page-chrome.js';
import { useSelection } from '../state/selection-context.js';
import { useKeyedAsync } from '../state/use-keyed-async.js';
import { useColorAssigner } from '../theme/colors-context.js';
import { traceFacts } from '../traces/trace-facts.js';

/** Neighbors requested on each side of the log in Surrounding logs. */
export const SURROUNDING_N = 10;

/** The shared log filter actions, with the error they raise rendered as a card above the tab. */
function useLogFilterActions(): ReturnType<typeof useFilterActions> & { errorNote: JSX.Element | null } {
  const actions = useFilterActions('log');
  return {
    ...actions,
    errorNote:
      actions.error === null ? null : (
        <p role="alert" className="mb-2 font-mono text-xs break-words whitespace-pre-wrap text-critical">
          {actions.error}
        </p>
      ),
  };
}

function recordFields(row: LogRow): readonly (readonly [string, string])[] {
  const l = row.log;
  return [
    ['severity_number', String(l.severityNumber)],
    ['severity_text', l.severityText === '' ? '(none)' : l.severityText],
    ['flags', String(l.flags)],
    ['event.name', l.eventName === '' ? '(none)' : l.eventName],
    ['dropped_attributes_count', String(l.droppedAttributesCount)],
  ];
}

export function AttributesTab(props: { row: LogRow }): JSX.Element {
  const { row } = props;
  const actions = useLogFilterActions();
  return (
    <div>
      {actions.errorNote}
      {row.log.attributes.size === 0 ? (
        <p className="text-sm text-muted">This log has no attributes.</p>
      ) : (
        <AttributeGroups attributes={row.log.attributes} pinned={[]} {...actions.attribute} />
      )}
      <details className="mt-3 rounded-card border border-hairline p-3">
        <summary className="cursor-pointer text-sm font-semibold">Record</summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {recordFields(row).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-sm text-ink-2">{k}</dt>
              <dd className="font-mono text-xs break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

const VIEW_BTN = 'rounded-full px-3 py-0.5 text-sm';

/**
 * The log's trace as the shared flame graph (or waterfall) with the emitting span outlined and a dashed "this log"
 * line at the log's time. Clicking a span opens the trace overlay over the Logs Explorer.
 */
export function LogTraceTab(props: { dataSource: DataSource; row: LogRow }): JSX.Element {
  const { dataSource, row } = props;
  const openSpanFromLog = useSelection((s) => s.openSpanFromLog);
  const goTo = useGoTo();
  const colors = useColorAssigner();
  const [view, setView] = useState<'flame' | 'waterfall'>('flame');
  const traceId = row.log.traceId;
  const spanId = row.log.spanId;
  const loadTrace = useCallback((id: TraceId) => dataSource.getTrace(id), [dataSource]);
  const current = useKeyedAsync(traceId, loadTrace);
  const time = row.time;
  const timeSource = row.timeSource;
  const markers = useMemo(
    () => (timeSource === 'none' ? [] : [{ time, label: 'this log' }]),
    [time, timeSource],
  );
  if (traceId === null) return <p className="text-sm text-muted">This log has no trace.</p>;
  if (current.status === 'loading') return <p className="text-sm text-muted">Loading trace...</p>;
  if (current.status === 'error') {
    return (
      <p role="alert" className="font-mono text-xs break-words whitespace-pre-wrap text-critical">
        {current.message}
      </p>
    );
  }
  const detail = current.value;
  const facts = traceFacts(detail);
  const inTrace = spanId !== null && detail.tree.byId.has(spanId);
  const select = (id: SpanId): void => {
    openSpanFromLog(traceId, id);
  };
  return (
    <div data-testid="log-trace-tab" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm font-semibold">
          <span>{facts.root?.service ?? 'unknown service'}</span>
          <span aria-hidden className="text-muted">
            ›
          </span>
          <span className="min-w-0 break-words">{facts.root?.resource ?? 'unknown resource'}</span>
        </h3>
        <span className="font-mono text-xs tabular-nums text-ink-2">
          {formatDuration(facts.durationNs)} · {facts.spans} {facts.spans === 1 ? 'span' : 'spans'}
        </span>
        {facts.errors > 0 && (
          <span className="rounded-full border border-critical px-2 py-0.5 text-xs text-critical">Error</span>
        )}
        <fieldset className="ml-auto flex items-center gap-1 rounded-full border border-hairline p-0.5">
          <legend className="sr-only">Trace view</legend>
          {(['flame', 'waterfall'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`${VIEW_BTN} ${view === v ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-hairline'}`}
            >
              {v === 'flame' ? 'Flame graph' : 'Waterfall'}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          className={CONTROL}
          onClick={() => goTo('traces', `/traces/trace/${traceId}`, inTrace ? { span: spanId } : {})}
        >
          Open trace →
        </button>
      </div>
      {spanId !== null && !inTrace && (
        <p role="note" className="text-xs text-muted">
          span <span className="font-mono">{spanId}</span> is not in this trace
        </p>
      )}
      {view === 'flame' ? (
        <FlameGraph
          detail={detail}
          selectedSpanId={null}
          onSelect={select}
          colors={colors}
          outlineSpanId={inTrace ? spanId : null}
          markers={markers}
        />
      ) : (
        <Waterfall
          tree={detail.tree}
          selectedSpanId={inTrace ? spanId : null}
          onSelect={select}
          colors={colors}
        />
      )}
    </div>
  );
}

export function LogResourceTab(props: { row: LogRow }): JSX.Element {
  const { row } = props;
  const actions = useLogFilterActions();
  return (
    <div>
      {actions.errorNote}
      <ResourceTab
        counts={[['Log attributes', row.log.droppedAttributesCount]]}
        resource={row.resource}
        scope={row.scope}
        resourceActions={actions.resource}
      />
    </div>
  );
}

export function SurroundingTab(props: {
  dataSource: DataSource;
  row: LogRow;
  epoch: UnixNanos;
}): JSX.Element {
  const { dataSource, row, epoch } = props;
  const sel = useSelection((s) => s);
  const ref = row.ref;
  const loadSurrounding = useCallback(
    (r: LogRef) => dataSource.surroundingLogs(r, SURROUNDING_N),
    [dataSource],
  );
  const current = useKeyedAsync(ref, loadSurrounding);
  const rows = useMemo(
    () =>
      current.status === 'ready' ? [...current.value.before, current.value.log, ...current.value.after] : [],
    [current],
  );
  if (current.status === 'loading') return <p className="text-sm text-muted">Loading surrounding logs...</p>;
  if (current.status === 'error') {
    return (
      <p role="alert" className="font-mono text-xs break-words whitespace-pre-wrap text-critical">
        {current.message}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        Logs from {row.service}
        {row.host === null ? '' : ` on ${row.host}`} around this one, in time order.
      </p>
      {current.value.partial && (
        <p className="text-xs text-ink-2">
          Partial: the scan stopped at its neighbor-chunk limit, so there may be more logs on a side.
        </p>
      )}
      <LogList
        rows={rows}
        sort={null}
        onSort={() => {}}
        onRowClick={(r) => sel.selectLog(r.ref)}
        selectedRef={ref}
        epoch={epoch}
        moveEnabled={false}
        height={360}
      />
    </div>
  );
}
