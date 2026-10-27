import { type JSX, useEffect, useMemo, useState } from 'react';
import type { AnyValue } from '../../model/anyvalue.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { UnixNanos } from '../../model/ids.js';
import { addAttributeFilter } from '../components/attribute-filter.js';
import { AttributeGroups } from '../components/attribute-groups.js';
import { LogList } from '../components/log-list.js';
import { type AttributeActions, ResourceTab } from '../components/resource-tab.js';
import type { DataSource, SurroundingLogs } from '../data/data-source.js';
import type { LogRow } from '../data/log-query.js';
import { useSelection } from '../state/selection-context.js';

/** Neighbors requested on each side of the log in Surrounding logs. */
export const SURROUNDING_N = 10;

/** Filter / exclude actions that write into the explorer's condition; a condition they cannot extend shows its error. */
function useFilterActions(): {
  attribute: AttributeActions;
  resource: AttributeActions;
  error: JSX.Element | null;
} {
  const sel = useSelection((s) => s);
  const [error, setError] = useState<string | null>(null);
  const filter =
    (scope: 'attribute' | 'resource', op: '==' | '!=') =>
    (key: string, value: AnyValue): void => {
      try {
        setError(null);
        sel.setCondition(addAttributeFilter(sel.condition, scope, key, value, op, 'log'));
      } catch (e) {
        setError(e instanceof OtelHtmlError ? e.message : String(e));
      }
    };
  return {
    attribute: { onFilter: filter('attribute', '=='), onExclude: filter('attribute', '!=') },
    resource: { onFilter: filter('resource', '=='), onExclude: filter('resource', '!=') },
    error:
      error === null ? null : (
        <p role="alert" className="mb-2 font-mono text-xs break-words whitespace-pre-wrap text-critical">
          {error}
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
  const actions = useFilterActions();
  return (
    <div>
      {actions.error}
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

/** Placeholder until the flame-graph view of the log's trace (M2 Task 13). */
export function TraceTab(): JSX.Element {
  return <p className="text-sm text-muted">The trace of this log opens here.</p>;
}

export function LogResourceTab(props: { row: LogRow }): JSX.Element {
  const { row } = props;
  const actions = useFilterActions();
  return (
    <div>
      {actions.error}
      <ResourceTab
        counts={[['Log attributes', row.log.droppedAttributesCount]]}
        resource={row.resource}
        scope={row.scope}
        resourceActions={actions.resource}
      />
    </div>
  );
}

type SurroundingState =
  | { status: 'ready'; ref: string; data: SurroundingLogs }
  | { status: 'error'; ref: string; message: string };

export function SurroundingTab(props: {
  dataSource: DataSource;
  row: LogRow;
  epoch: UnixNanos;
}): JSX.Element {
  const { dataSource, row, epoch } = props;
  const sel = useSelection((s) => s);
  const [state, setState] = useState<SurroundingState | null>(null);
  const ref = row.ref;
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => dataSource.surroundingLogs(ref, SURROUNDING_N))
      .then(
        (data) => live && setState({ status: 'ready', ref, data }),
        (e: unknown) =>
          live && setState({ status: 'error', ref, message: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [dataSource, ref]);
  const current = state !== null && state.ref === ref ? state : null;
  const rows = useMemo(
    () =>
      current?.status === 'ready' ? [...current.data.before, current.data.log, ...current.data.after] : [],
    [current],
  );
  if (current === null) return <p className="text-sm text-muted">Loading surrounding logs...</p>;
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
      {current.data.partial && (
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
