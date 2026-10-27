import { type JSX, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { RelNanos, SpanId, TraceId } from '../../model/ids.js';
import type { SpanEventRecord, SpanLinkRecord, SpanRecord } from '../../model/records.js';
import { formatDuration } from '../../semconv/formatters.js';
import { AttributeGroups } from '../components/attribute-groups.js';
import type { DataSource } from '../data/data-source.js';
import { navigateRoute } from '../shell/use-route.js';
import { selectionToUrlState } from '../state/selection.js';
import { useSelection } from '../state/selection-context.js';
import { serializeUrlState } from '../state/url-state.js';

const ID = 'font-mono text-xs break-all';

export function Muted(props: { children: ReactNode }): JSX.Element {
  return <p className="text-sm text-muted">{props.children}</p>;
}

/** Event offsets are shown from the span start, signed so a clock-skewed event before the start stays legible. */
export function formatOffset(from: RelNanos, to: RelNanos): string {
  const d = to - from;
  return d < 0 ? `-${formatDuration(-d)}` : `+${formatDuration(d)}`;
}

export function EventsTab(props: { span: SpanRecord }): JSX.Element {
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
          <AttributeGroups attributes={e.attributes} pinned={[]} />
          {e.droppedAttributesCount > 0 && <Muted>{e.droppedAttributesCount} attributes dropped</Muted>}
        </li>
      ))}
    </ol>
  );
}

type Presence = 'checking' | 'present' | 'absent' | 'unknown';

/** Whether another trace is in the report: an index lookup, remembered per trace id while the links are shown. */
function useTracePresence(
  probe: (id: TraceId) => Promise<boolean>,
  traceId: TraceId,
  skip: boolean,
): Presence {
  const [state, setState] = useState<{ traceId: TraceId; presence: Presence } | null>(null);
  useEffect(() => {
    if (skip) return;
    let live = true;
    probe(traceId).then(
      (found) => live && setState({ traceId, presence: found ? 'present' : 'absent' }),
      // A failed lookup says nothing about the report's contents.
      () => live && setState({ traceId, presence: 'unknown' }),
    );
    return () => {
      live = false;
    };
  }, [probe, traceId, skip]);
  return state !== null && state.traceId === traceId ? state.presence : 'checking';
}

function LinkTarget(props: {
  link: SpanLinkRecord;
  currentTrace: TraceId;
  probe: (id: TraceId) => Promise<boolean>;
  onSelectSpan(id: SpanId): void;
}): JSX.Element {
  const { link } = props;
  const sel = useSelection((s) => s);
  const same = link.traceId === props.currentTrace;
  const presence = useTracePresence(props.probe, link.traceId, same);
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
  if (presence === 'unknown') return <span className="text-sm text-muted">could not check</span>;
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
}): JSX.Element {
  const cache = useRef(new Map<TraceId, Promise<boolean>>());
  const { dataSource } = props;
  const probe = useCallback(
    (id: TraceId): Promise<boolean> => {
      let p = cache.current.get(id);
      if (p === undefined) {
        p = Promise.resolve().then(() => dataSource.hasTrace(id));
        cache.current.set(id, p);
        // A failure is not remembered, so a later visit can retry.
        p.catch(() => cache.current.delete(id));
      }
      return p;
    },
    [dataSource],
  );
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
              probe={probe}
              onSelectSpan={props.onSelectSpan}
            />
          </div>
          <AttributeGroups attributes={l.attributes} pinned={[]} />
          {l.droppedAttributesCount > 0 && <Muted>{l.droppedAttributesCount} attributes dropped</Muted>}
        </li>
      ))}
    </ul>
  );
}
