import { type JSX, type ReactNode, useEffect, useState } from 'react';
import type { RelNanos, SpanId, TraceId } from '../../model/ids.js';
import type {
  ResourceRecord,
  ScopeRecord,
  SpanEventRecord,
  SpanLinkRecord,
  SpanRecord,
} from '../../model/records.js';
import { formatDuration } from '../../semconv/formatters.js';
import { AttributeGroups, type AttributeGroupsProps } from '../components/attribute-groups.js';
import type { DataSource } from '../data/data-source.js';
import { navigateRoute } from '../shell/use-route.js';
import { selectionToUrlState } from '../state/selection.js';
import { useSelection } from '../state/selection-context.js';
import { serializeUrlState } from '../state/url-state.js';

export type AttributeActions = Omit<AttributeGroupsProps, 'attributes' | 'pinned'>;

const ID = 'font-mono text-xs break-all';

export function Muted(props: { children: ReactNode }): JSX.Element {
  return <p className="text-sm text-muted">{props.children}</p>;
}

/** Event offsets are shown from the span start, signed so a clock-skewed event before the start stays legible. */
export function formatOffset(from: RelNanos, to: RelNanos): string {
  const d = to - from;
  return d < 0 ? `-${formatDuration(-d)}` : `+${formatDuration(d)}`;
}

export function EventsTab(props: { span: SpanRecord; actions: AttributeActions }): JSX.Element {
  return (
    <ol className="flex flex-col gap-3" aria-label="Span events">
      {props.span.events.map((e: SpanEventRecord, i) => (
        // Events have no identity of their own; the order is stable for a loaded span.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <li key={i} className="rounded-card border border-hairline p-3">
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span className="font-mono text-xs tabular-nums text-ink-2">
              {formatOffset(props.span.start, e.time)}
            </span>
            <span className="min-w-0 font-semibold break-words">{e.name}</span>
          </p>
          <AttributeGroups attributes={e.attributes} pinned={[]} {...props.actions} />
          {e.droppedAttributesCount > 0 && <Muted>{e.droppedAttributesCount} attributes dropped</Muted>}
        </li>
      ))}
    </ol>
  );
}

type Presence = 'checking' | 'present' | 'absent';

/** Whether another trace is in the report, asked of the data source (a missing trace rejects). */
function useTracePresence(dataSource: DataSource, traceId: TraceId, skip: boolean): Presence {
  const [state, setState] = useState<{ traceId: TraceId; presence: Presence } | null>(null);
  useEffect(() => {
    if (skip) return;
    let live = true;
    Promise.resolve()
      .then(() => dataSource.getTrace(traceId))
      .then(
        () => live && setState({ traceId, presence: 'present' }),
        () => live && setState({ traceId, presence: 'absent' }),
      );
    return () => {
      live = false;
    };
  }, [dataSource, traceId, skip]);
  return state !== null && state.traceId === traceId ? state.presence : 'checking';
}

function LinkTarget(props: {
  link: SpanLinkRecord;
  currentTrace: TraceId;
  dataSource: DataSource;
  onSelectSpan(id: SpanId): void;
}): JSX.Element {
  const { link } = props;
  const sel = useSelection((s) => s);
  const same = link.traceId === props.currentTrace;
  const presence = useTracePresence(props.dataSource, link.traceId, same);
  if (same) {
    return (
      <button
        type="button"
        className="rounded-full border border-hairline px-3 py-1 text-sm hover:bg-hairline"
        onClick={() => props.onSelectSpan(link.spanId)}
      >
        Go to span {link.spanId} in this trace
      </button>
    );
  }
  if (presence === 'absent') return <span className="text-sm text-muted">not in this report</span>;
  if (presence === 'checking') return <span className="text-sm text-muted">checking...</span>;
  const search = serializeUrlState(selectionToUrlState({ ...sel, traceId: null, spanId: link.spanId }));
  const route = `/traces/trace/${link.traceId}`;
  return (
    <a
      href={`#${route}${search === '' ? '' : `?${search}`}`}
      aria-label={`Open trace ${link.traceId}`}
      className="rounded-full border border-hairline px-3 py-1 text-sm hover:bg-hairline"
      onClick={(ev) => {
        ev.preventDefault();
        navigateRoute(window, route, search);
      }}
    >
      Open trace
    </a>
  );
}

export function LinksTab(props: {
  span: SpanRecord;
  dataSource: DataSource;
  onSelectSpan(id: SpanId): void;
  actions: AttributeActions;
}): JSX.Element {
  return (
    <ul className="flex flex-col gap-3" aria-label="Span links">
      {props.span.links.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: links have no identity of their own
        <li key={i} className="rounded-card border border-hairline p-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-xs text-muted">Trace</dt>
            <dd className={ID}>{l.traceId}</dd>
            <dt className="text-xs text-muted">Span</dt>
            <dd className={ID}>{l.spanId}</dd>
            {l.traceState !== '' && (
              <>
                <dt className="text-xs text-muted">Trace state</dt>
                <dd className={ID}>{l.traceState}</dd>
              </>
            )}
          </dl>
          <div className="my-2">
            <LinkTarget
              link={l}
              currentTrace={props.span.traceId}
              dataSource={props.dataSource}
              onSelectSpan={props.onSelectSpan}
            />
          </div>
          <AttributeGroups attributes={l.attributes} pinned={[]} {...props.actions} />
          {l.droppedAttributesCount > 0 && <Muted>{l.droppedAttributesCount} attributes dropped</Muted>}
        </li>
      ))}
    </ul>
  );
}

function Counts(props: { rows: readonly (readonly [string, number])[] }): JSX.Element {
  return (
    <section aria-label="Dropped counts" className="mb-3">
      <h4 className="mb-1 text-xs font-semibold tracking-wide text-ink-2 uppercase">Dropped counts</h4>
      <dl className="grid grid-cols-[auto_auto] justify-start gap-x-4 gap-y-1">
        {props.rows.map(([label, n]) => (
          <div key={label} className="contents">
            <dt className="text-sm text-ink-2">{label}</dt>
            <dd className="font-mono text-sm tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Schema(props: { label: string; url: string }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-x-3">
      <dt className="text-sm text-ink-2">{props.label}</dt>
      <dd className={ID}>{props.url === '' ? 'none' : props.url}</dd>
    </div>
  );
}

export function ResourceTab(props: {
  span: SpanRecord;
  resource: ResourceRecord;
  scope: ScopeRecord;
  resourceActions: AttributeActions;
}): JSX.Element {
  const { span, resource, scope } = props;
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">Resource</h3>
      <AttributeGroups attributes={resource.attributes} pinned={[]} {...props.resourceActions} />
      <h3 className="mt-4 mb-1 text-sm font-semibold">
        Scope <span className="font-mono text-xs font-normal">{scope.name}</span>
        {scope.version !== '' && <span className="font-mono text-xs font-normal"> {scope.version}</span>}
      </h3>
      <AttributeGroups attributes={scope.attributes} pinned={[]} />
      <section aria-label="Schema URLs" className="my-3">
        <h4 className="mb-1 text-xs font-semibold tracking-wide text-ink-2 uppercase">Schema URLs</h4>
        <dl className="flex flex-col gap-1">
          <Schema label="Resource" url={resource.schemaUrl} />
          <Schema label="Scope" url={scope.schemaUrl} />
        </dl>
      </section>
      <Counts
        rows={[
          ['Span attributes', span.droppedAttributesCount],
          ['Events', span.droppedEventsCount],
          ['Links', span.droppedLinksCount],
          ['Resource attributes', resource.droppedAttributesCount],
          ['Scope attributes', scope.droppedAttributesCount],
        ]}
      />
    </div>
  );
}
