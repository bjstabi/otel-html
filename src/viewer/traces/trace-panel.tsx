import { Tabs } from '@base-ui/react/tabs';
import { CircleAlert, Copy, Download, Maximize2, X } from 'lucide-react';
import { type JSX, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { OtelHtmlError } from '../../model/errors.js';
import { parseUnixNanos, type RelNanos, type SpanId, type TraceId, type UnixNanos } from '../../model/ids.js';
import { formatDuration, formatTime } from '../../semconv/formatters.js';
import { downloadBlob, otlpBlob } from '../components/export.js';
import { FlameGraph } from '../components/flame-graph.js';
import { Waterfall } from '../components/waterfall.js';
import type { DataSource, TraceDetail } from '../data/data-source.js';
import { MOVE_EVENT } from '../shell/move-event.js';
import { CONTROL, CopyLink } from '../shell/page-chrome.js';
import { selectionToUrlState } from '../state/selection.js';
import { useSelection } from '../state/selection-context.js';
import { serializeUrlState } from '../state/url-state.js';
import { useColorAssigner } from '../theme/colors-context.js';
import { StatusDot } from './columns.js';
import { SplitPane } from './split-pane.js';
import { availableTabs, isTraceTabId, type TraceTabId } from './tabs.js';
import { traceFacts } from './trace-facts.js';
import { ErrorsTab, ServicesTab, SpanListTab } from './trace-tabs.js';

/** What the span section (Task 22) receives to render the selected span. */
export interface SpanSectionProps {
  detail: TraceDetail;
  spanId: SpanId | null;
  epoch: UnixNanos;
}

export interface TracePanelProps {
  dataSource: DataSource;
  traceId: TraceId;
  /** `overlay` slides over the explorer; `page` is the full-width `#/traces/trace/<id>` route. */
  layout: 'overlay' | 'page';
  /**
   * Distinct trace ids in the current result order. Only an overlay panel with this list consumes the shell's
   * j/k `oh:move` event (the results table stands down while a trace is open, so exactly one consumer acts).
   */
  traceIds?: readonly TraceId[];
  onClose(): void;
  /** Mount point for the span section; a labelled placeholder is shown when absent. */
  renderSpanSection?: (props: SpanSectionProps) => ReactNode;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; detail: TraceDetail }
  | { status: 'error'; message: string };

function useTraceDetail(dataSource: DataSource, traceId: TraceId): LoadState {
  const [state, setState] = useState<{ traceId: TraceId; load: LoadState } | null>(null);
  useEffect(() => {
    let live = true;
    // `getTrace` is async, but a source that throws synchronously must still land in the error card.
    Promise.resolve()
      .then(() => dataSource.getTrace(traceId))
      .then(
        (detail) => live && setState({ traceId, load: { status: 'ready', detail } }),
        (e: unknown) =>
          live &&
          setState({
            traceId,
            load: {
              status: 'error',
              message: e instanceof OtelHtmlError ? e.message : e instanceof Error ? e.message : String(e),
            },
          }),
      );
    return () => {
      live = false;
    };
  }, [dataSource, traceId]);
  // A result for another trace is stale (the user moved on): show the skeleton until the right one lands.
  return state !== null && state.traceId === traceId ? state.load : { status: 'loading' };
}

function Skeleton(props: { traceId: TraceId }): JSX.Element {
  return (
    <div role="status" aria-busy="true" aria-label="Loading trace" className="flex flex-col gap-3 p-4">
      <p className="font-mono text-xs tabular-nums text-muted">{props.traceId}</p>
      <div className="h-6 w-2/3 animate-pulse rounded-md bg-hairline" />
      <div className="h-4 w-1/2 animate-pulse rounded-md bg-hairline" />
      <div className="h-40 animate-pulse rounded-card bg-hairline" />
    </div>
  );
}

function LoadError(props: { traceId: TraceId; message: string }): JSX.Element {
  return (
    <div role="alert" className="m-4 rounded-card border border-hairline bg-surface p-4">
      <p className="font-semibold text-critical">The trace could not be loaded</p>
      <p className="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-ink-2">
        trace {props.traceId}: {props.message}
      </p>
    </div>
  );
}

function Fact(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{props.label}</dt>
      <dd className="font-mono text-sm tabular-nums">{props.children}</dd>
    </div>
  );
}

function CopyId(props: { id: string }): JSX.Element {
  const [note, setNote] = useState('');
  const copy = async (): Promise<void> => {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    try {
      if (clipboard === undefined) throw new Error('clipboard unavailable');
      await clipboard.writeText(props.id);
      setNote('Copied');
    } catch {
      setNote('Copy failed: select the ID and copy it');
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="Copy trace ID"
        onClick={() => void copy()}
        className="rounded-full p-1 hover:bg-hairline"
      >
        <Copy size={14} aria-hidden />
      </button>
      <span role="status" className={note === '' ? 'sr-only' : 'text-xs text-ink-2'}>
        {note}
      </span>
    </span>
  );
}

function Header(props: { detail: TraceDetail; dataSource: DataSource; epoch: UnixNanos }): JSX.Element {
  const { detail, dataSource, epoch } = props;
  const f = useMemo(() => traceFacts(detail), [detail]);
  const root = f.root;
  const percentile =
    root === null ? null : dataSource.percentileOf(root.service, root.resource, root.durationNs);
  return (
    <div className="flex flex-col gap-2" data-testid="trace-header">
      <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold">
        <span>{root?.service ?? 'unknown service'}</span>
        <span aria-hidden className="text-muted">
          ›
        </span>
        <span className="min-w-0 break-words">{root?.resource ?? 'unknown resource'}</span>
        <span aria-hidden className="text-muted">
          ›
        </span>
        <span className="font-mono text-sm font-normal tabular-nums break-all">{detail.traceId}</span>
        <CopyId id={detail.traceId} />
      </h2>
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        <Fact label="Duration">
          <span className="inline-flex items-center gap-2">
            {formatDuration(f.durationNs)}
            {percentile !== null && (
              <span
                title="Percentile of this root span's duration among spans of the same service and resource"
                className="rounded-full bg-ink/10 px-2 py-0.5 text-xs"
              >
                p{Math.round(percentile)}
              </span>
            )}
          </span>
        </Fact>
        {f.method !== null || f.url !== null ? (
          <Fact label="Request">
            <span className="break-all">{[f.method, f.url].filter((x) => x !== null).join(' ')}</span>
          </Fact>
        ) : null}
        {f.statusCode !== null && <Fact label="Status code">{f.statusCode}</Fact>}
        <Fact label="State">
          {f.errors > 0 ? (
            <StatusDot error label={`${f.errors} ${f.errors === 1 ? 'error' : 'errors'}`} />
          ) : (
            <StatusDot error={false} label="No errors" />
          )}
        </Fact>
        <Fact label="Start">{formatTime(f.start as RelNanos, epoch)}</Fact>
        <Fact label="Spans">{f.spans}</Fact>
        <Fact label="Services">{f.services}</Fact>
        <Fact label="Errors">{f.errors}</Fact>
      </dl>
    </div>
  );
}

const TAB_BASE =
  'rounded-full px-3 py-1 text-sm text-ink-2 hover:bg-hairline data-[active]:bg-ink data-[active]:text-surface';

/** Where Task 22's span section mounts until it exists. */
function SpanSectionPlaceholder(props: SpanSectionProps): JSX.Element {
  return (
    <section
      aria-label="Span details"
      data-testid="span-section-slot"
      className="m-3 rounded-card border border-dashed border-hairline p-4 text-sm text-ink-2"
    >
      <p className="font-semibold">Span details</p>
      <p className="mt-1">
        The span section is not part of this build yet.{' '}
        {props.spanId === null ? (
          'Select a span in the trace above.'
        ) : (
          <>
            Selected span <span className="font-mono tabular-nums">{props.spanId}</span>.
          </>
        )}
      </p>
    </section>
  );
}

/**
 * Trace panel: header, trace tabs (flame graph, waterfall, span list, services, errors), a resizable split and the
 * span section slot. It is a complementary region, not a dialog, so the shell's keyboard shortcuts keep working.
 */
export function TracePanel(props: TracePanelProps): JSX.Element {
  const { dataSource, traceId, layout, traceIds, onClose } = props;
  const sel = useSelection((s) => s);
  const colors = useColorAssigner();
  const load = useTraceDetail(dataSource, traceId);
  const epoch = useMemo(
    () => parseUnixNanos(dataSource.manifest.epochUnixNano, 'manifest.epochUnixNano'),
    [dataSource],
  );
  const [exportError, setExportError] = useState<string | null>(null);

  // j/k: with the panel open it owns the move event, so the next/previous trace in the result order opens.
  const latest = useRef({ traceId, traceIds, select: sel.selectTrace });
  latest.current = { traceId, traceIds, select: sel.selectTrace };
  const movable = layout === 'overlay' && traceIds !== undefined;
  useEffect(() => {
    if (!movable) return;
    const onMove = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      const delta: unknown = e.detail;
      if (delta !== 1 && delta !== -1) return;
      const { traceId: current, traceIds: ids, select } = latest.current;
      if (ids === undefined || ids.length === 0) return;
      const at = ids.indexOf(current);
      const next =
        at === -1 ? (delta === 1 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + delta));
      const target = ids[next];
      if (target !== undefined && target !== current) select(target);
    };
    window.addEventListener(MOVE_EVENT, onMove);
    return () => window.removeEventListener(MOVE_EVENT, onMove);
  }, [movable]);

  // Closing returns focus to the row the panel was opened from (the selected row of the results grid).
  const origin = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-capture the row whenever the open trace or span changes
  useEffect(() => {
    const row = document.querySelector<HTMLElement>('[role="grid"] [role="row"][data-selected="true"]');
    if (row !== null) origin.current = row;
    else if (origin.current === null && document.activeElement instanceof HTMLElement)
      origin.current = document.activeElement;
  }, [traceId, sel.spanId]);
  useEffect(
    () => () => {
      if (layout !== 'overlay') return;
      const el = origin.current;
      if (el?.isConnected === true) el.focus();
      else document.querySelector<HTMLElement>('[role="grid"] [role="row"][tabindex="0"]')?.focus();
    },
    [layout],
  );

  const tabs = load.status === 'ready' ? availableTabs(load.detail) : [];
  const wanted = sel.tabs.trace;
  const active: TraceTabId | null =
    tabs.length === 0 ? null : (tabs.find((t) => t.id === wanted)?.id ?? tabs[0]?.id ?? null);

  const exportTrace = (detail: TraceDetail): void => {
    try {
      setExportError(null);
      downloadBlob(
        otlpBlob({
          epoch,
          groups: [
            { spans: detail.spans.map((r) => r.span), resources: detail.resources, scopes: detail.scopes },
          ],
        }),
        `trace-${detail.traceId}.otlp.json`,
      );
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  };

  const fullPageHref = `#/traces/trace/${traceId}${(() => {
    const search = serializeUrlState(selectionToUrlState({ ...sel, traceId: null, spanId: null }));
    return search === '' ? '' : `?${search}`;
  })()}`;

  const selectSpan = (id: SpanId): void => sel.selectSpan(id);

  const body = (detail: TraceDetail, tab: TraceTabId): JSX.Element => {
    switch (tab) {
      case 'flame':
        return (
          <FlameGraph detail={detail} selectedSpanId={sel.spanId} onSelect={selectSpan} colors={colors} />
        );
      case 'waterfall':
        return (
          <Waterfall tree={detail.tree} selectedSpanId={sel.spanId} onSelect={selectSpan} colors={colors} />
        );
      case 'spans':
        return (
          <SpanListTab
            detail={detail}
            selectedSpanId={sel.spanId}
            onSelect={selectSpan}
            epoch={epoch}
            colors={colors}
          />
        );
      case 'services':
        return <ServicesTab detail={detail} colors={colors} />;
      case 'errors':
        return (
          <ErrorsTab detail={detail} selectedSpanId={sel.spanId} onSelect={selectSpan} colors={colors} />
        );
      default: {
        const never: never = tab;
        throw new Error(`unhandled trace tab ${String(never)}`);
      }
    }
  };

  const frame =
    layout === 'overlay'
      ? 'oh-slide-in fixed inset-y-0 right-0 z-30 flex w-full flex-col border-l border-hairline bg-page shadow-xl md:w-[max(32rem,calc(100vw-30rem))]'
      : 'flex min-h-0 w-full flex-1 flex-col bg-page';

  return (
    <aside aria-label="Trace" data-testid="trace-panel" data-layout={layout} className={frame}>
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface px-4 py-2">
        <h1 className="mr-auto text-sm font-semibold text-ink-2">Trace</h1>
        {layout === 'overlay' && (
          <a href={fullPageHref} className={CONTROL}>
            <Maximize2 size={16} aria-hidden />
            Full page
          </a>
        )}
        <CopyLink />
        <button
          type="button"
          className={CONTROL}
          disabled={load.status !== 'ready'}
          onClick={() => load.status === 'ready' && exportTrace(load.detail)}
        >
          <Download size={16} aria-hidden />
          Export trace
        </button>
        <button type="button" className={CONTROL} aria-label="Close trace" onClick={onClose}>
          <X size={16} aria-hidden />
          Close
        </button>
      </div>
      {exportError !== null && (
        <p role="alert" className="flex items-center gap-2 px-4 py-2 text-sm text-critical">
          <CircleAlert size={14} aria-hidden />
          The export failed: <span className="font-mono text-xs">{exportError}</span>
        </p>
      )}
      {load.status === 'loading' && <Skeleton traceId={traceId} />}
      {load.status === 'error' && <LoadError traceId={traceId} message={load.message} />}
      {load.status === 'ready' && active !== null && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <div className="rounded-card border border-hairline bg-surface p-4">
            <Header detail={load.detail} dataSource={dataSource} epoch={epoch} />
          </div>
          <Tabs.Root
            value={active}
            onValueChange={(v) => {
              if (typeof v === 'string' && isTraceTabId(v)) sel.setTab('trace', v);
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <Tabs.List aria-label="Trace views" className="flex flex-wrap gap-1 pb-2">
              {tabs.map((t) => (
                <Tabs.Tab key={t.id} value={t.id} className={TAB_BASE}>
                  {t.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <SplitPane
              label="Resize trace and span sections"
              top={
                <Tabs.Panel value={active} className="p-1 outline-none">
                  {body(load.detail, active)}
                </Tabs.Panel>
              }
              bottom={(props.renderSpanSection ?? ((p) => <SpanSectionPlaceholder {...p} />))({
                detail: load.detail,
                spanId: sel.spanId,
                epoch,
              })}
            />
          </Tabs.Root>
        </div>
      )}
    </aside>
  );
}
