import { Tabs } from '@base-ui/react/tabs';
import { CircleAlert, Copy, Download, ListTree, X } from 'lucide-react';
import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { logsToOtlpJson } from '../../format/otlp-export.js';
import { type AnyValue, anyValueToDisplay } from '../../model/anyvalue.js';
import type { SpanId, TraceId } from '../../model/ids.js';
import { parseUnixNanos } from '../../model/ids.js';
import { formatTime } from '../../semconv/formatters.js';
import { downloadBlob } from '../components/export.js';
import { LogBody } from '../components/log-body.js';
import { SeverityBadge } from '../components/severity.js';
import type { DataSource } from '../data/data-source.js';
import { type LogRef, type LogRow, refParts } from '../data/log-query.js';
import { useHasMetrics } from '../metrics/metric-grid.js';
import { MOVE_EVENT } from '../shell/move-event.js';
import { CONTROL, CopyLink } from '../shell/page-chrome.js';
import { useSelection, useSelectionStore } from '../state/selection-context.js';
import { type KeyedState, useKeyedAsync } from '../state/use-keyed-async.js';
import { AttributesTab, LogMetricsTab, LogResourceTab, LogTraceTab, SurroundingTab } from './log-tabs.js';
import { availableLogTabs, isLogTabId, type LogTabId } from './tabs.js';

export interface LogPanelProps {
  dataSource: DataSource;
  logRef: LogRef;
  /** The visible rows' refs in order: what j/k step through. */
  logRefs?: readonly LogRef[];
  onClose(): void;
}

function useLog(dataSource: DataSource, logRef: LogRef): KeyedState<LogRow> {
  const load = useCallback((ref: LogRef) => dataSource.getLog(ref), [dataSource]);
  return useKeyedAsync(logRef, load);
}

type Presence = 'checking' | 'present' | 'absent' | 'unknown';

/** Whether the log's trace has spans in the report: an index lookup only. */
function useTracePresence(dataSource: DataSource, traceId: TraceId | null): Presence {
  const [state, setState] = useState<{ traceId: TraceId; presence: Presence } | null>(null);
  useEffect(() => {
    if (traceId === null) return;
    let live = true;
    Promise.resolve()
      .then(() => dataSource.hasTrace(traceId))
      .then(
        (found) => live && setState({ traceId, presence: found ? 'present' : 'absent' }),
        // A failed lookup says nothing about the report's contents.
        () => live && setState({ traceId, presence: 'unknown' }),
      );
    return () => {
      live = false;
    };
  }, [dataSource, traceId]);
  if (traceId === null) return 'absent';
  return state !== null && state.traceId === traceId ? state.presence : 'checking';
}

function Fact(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col rounded-card border border-hairline bg-surface p-3">
      <dt className="text-xs text-muted">{props.label}</dt>
      <dd className="min-w-0 font-mono text-sm break-all">{props.children}</dd>
    </div>
  );
}

const SUB = 'text-xs text-muted';
const LINK = 'underline decoration-hairline underline-offset-2 hover:text-accent';

function TraceFact(props: {
  traceId: TraceId | null;
  spanId: SpanId | null;
  presence: Presence;
}): JSX.Element {
  const { traceId, spanId, presence } = props;
  if (traceId === null) {
    return (
      <>
        <span className="text-ink-2">no trace</span>
        {spanId !== null && <span className={`${SUB} block`}>span {spanId}</span>}
      </>
    );
  }
  if (presence === 'present') {
    const base = `#/traces/trace/${traceId}`;
    return (
      <>
        <a href={base} className={LINK}>
          {traceId}
        </a>
        {spanId !== null && (
          <span className="block">
            <span className={SUB}>span </span>
            <a href={`${base}?span=${spanId}`} className={LINK}>
              {spanId}
            </a>
          </span>
        )}
      </>
    );
  }
  const note =
    presence === 'absent'
      ? 'trace not in this report'
      : presence === 'unknown'
        ? 'could not check the trace'
        : '';
  return (
    <>
      <span>{traceId}</span>
      {spanId !== null && <span className={`${SUB} block`}>span {spanId}</span>}
      {note !== '' && <span className={`${SUB} block font-sans`}>{note}</span>}
    </>
  );
}

function CopyBody(props: { body: AnyValue }): JSX.Element {
  const [note, setNote] = useState('');
  const copy = async (): Promise<void> => {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    try {
      if (clipboard === undefined) throw new Error('clipboard unavailable');
      await clipboard.writeText(anyValueToDisplay(props.body));
      setNote('Copied');
    } catch {
      setNote('Copy failed: select the text and copy it');
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="Copy body"
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

const TAB_BASE =
  'rounded-full px-3 py-1 text-sm text-ink-2 hover:bg-hairline data-[active]:bg-ink data-[active]:text-surface';
const TOGGLE = 'rounded-full px-2 py-0.5 text-xs';

/** The time line: the record's time, else its observed time (marked), else "no timestamp". */
function Timestamps(props: { row: LogRow; epoch: ReturnType<typeof parseUnixNanos> }): JSX.Element {
  const { row, epoch } = props;
  const observed = row.log.observedTime;
  return (
    <span className="flex flex-wrap items-baseline gap-x-3 font-mono text-xs tabular-nums text-ink-2">
      {row.timeSource === 'none' ? (
        <span>no timestamp</span>
      ) : row.timeSource === 'observed' ? (
        <span>observed {formatTime(row.time, epoch)}</span>
      ) : (
        <>
          <span>{formatTime(row.time, epoch)}</span>
          {observed !== null && <span>observed {formatTime(observed, epoch)}</span>}
        </>
      )}
    </span>
  );
}

/**
 * Log detail overlay: header, fact cards, body and tabs. Like the trace overlay it is a complementary region, not a
 * dialog, so the shell's keyboard shortcuts keep working.
 */
export function LogPanel(props: LogPanelProps): JSX.Element {
  const { dataSource, logRef, logRefs, onClose } = props;
  const sel = useSelection((s) => s);
  const load = useLog(dataSource, logRef);
  // While the next log loads (j/k), the open one stays on screen: no skeleton flash, and the content is not remounted.
  const lastReady = useRef<LogRow | null>(null);
  if (load.status === 'ready') lastReady.current = load.value;
  else if (load.status === 'error') lastReady.current = null;
  const row = load.status === 'ready' ? load.value : load.status === 'loading' ? lastReady.current : null;
  const stale = load.status === 'loading' && row !== null;
  const epoch = useMemo(
    () => parseUnixNanos(dataSource.manifest.epochUnixNano, 'manifest.epochUnixNano'),
    [dataSource],
  );
  const presence = useTracePresence(dataSource, row?.log.traceId ?? null);
  const metricResources = useMemo(() => (row === null ? null : [row.resource]), [row]);
  const hasMetrics = useHasMetrics(dataSource, metricResources);
  const [bodyMode, setBodyMode] = useState<'raw' | 'wrapped'>('wrapped');
  const [exportError, setExportError] = useState<string | null>(null);

  // j/k: with the panel open it owns the move event, so the next/previous log in the visible order opens.
  // The open log is read from the store at event time, so presses faster than a re-render still chain.
  const store = useSelectionStore();
  const latest = useRef(logRefs);
  latest.current = logRefs;
  // With a trace overlay open too, the trace panel owns j/k.
  const movable = logRefs !== undefined && sel.traceId === null;
  useEffect(() => {
    if (!movable) return;
    const onMove = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      const delta: unknown = e.detail;
      if (delta !== 1 && delta !== -1) return;
      const refs = latest.current;
      const { logRef: current, selectLog: select } = store.getState();
      if (current === null || refs === undefined || refs.length === 0) return;
      const at = refs.indexOf(current);
      const next =
        at === -1 ? (delta === 1 ? 0 : refs.length - 1) : Math.min(refs.length - 1, Math.max(0, at + delta));
      const target = refs[next];
      if (target !== undefined && target !== current) select(target);
    };
    window.addEventListener(MOVE_EVENT, onMove);
    return () => window.removeEventListener(MOVE_EVENT, onMove);
  }, [movable, store]);

  // Closing returns focus to the row the panel was opened from, or the grid's focusable row.
  const origin = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const selected = document.querySelector<HTMLElement>('[role="grid"] [role="row"][data-selected="true"]');
    if (selected !== null) origin.current = selected;
    else if (document.activeElement instanceof HTMLElement) origin.current = document.activeElement;
    return () => {
      const el = origin.current;
      if (el?.isConnected === true) el.focus();
      else document.querySelector<HTMLElement>('[role="grid"] [role="row"][tabindex="0"]')?.focus();
    };
  }, []);

  const tabs = row === null ? [] : availableLogTabs(row, { hasTrace: presence === 'present', hasMetrics });
  const wanted = sel.tabs.log;
  const active: LogTabId | null =
    tabs.length === 0 ? null : (tabs.find((t) => t.id === wanted)?.id ?? tabs[0]?.id ?? null);

  const exportLog = (r: LogRow): void => {
    try {
      setExportError(null);
      const { n, i } = refParts(r.ref);
      downloadBlob(
        new Blob([JSON.stringify(logsToOtlpJson([r], epoch))], { type: 'application/json' }),
        `log-${n}.${i}.otlp.json`,
      );
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  };

  const body = (r: LogRow, tab: LogTabId): JSX.Element => {
    switch (tab) {
      case 'attributes':
        return <AttributesTab row={r} />;
      case 'trace':
        return <LogTraceTab dataSource={dataSource} row={r} />;
      case 'metrics':
        return <LogMetricsTab dataSource={dataSource} row={r} />;
      case 'surrounding':
        return <SurroundingTab dataSource={dataSource} row={r} epoch={epoch} />;
      case 'resource':
        return <LogResourceTab row={r} />;
      default: {
        const never: never = tab;
        throw new Error(`unhandled log tab ${String(never)}`);
      }
    }
  };

  return (
    <aside
      aria-label="Log"
      data-testid="log-panel"
      className="oh-slide-in fixed inset-y-0 right-0 z-30 flex w-full flex-col overflow-y-auto border-l border-hairline bg-page shadow-xl md:w-[max(32rem,calc(100vw-30rem))]"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface px-4 py-2">
        <h1 className="mr-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold">
          {row === null ? (
            <span className="text-ink-2">Log</span>
          ) : (
            <>
              <SeverityBadge number={row.log.severityNumber} text={row.log.severityText} />
              <Timestamps row={row} epoch={epoch} />
            </>
          )}
        </h1>
        <button
          type="button"
          className={CONTROL}
          disabled={row === null}
          onClick={() => sel.setTab('log', 'surrounding')}
        >
          <ListTree size={16} aria-hidden />
          Surrounding logs
        </button>
        <CopyLink />
        <button
          type="button"
          className={CONTROL}
          disabled={row === null || stale}
          onClick={() => row !== null && !stale && exportLog(row)}
        >
          <Download size={16} aria-hidden />
          Export
        </button>
        <button type="button" className={CONTROL} aria-label="Close log" onClick={onClose}>
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
      {load.status === 'loading' && !stale && (
        <div role="status" aria-busy="true" aria-label="Loading log" className="flex flex-col gap-3 p-4">
          <p className="font-mono text-xs tabular-nums text-muted">{logRef}</p>
          <div className="h-6 w-2/3 animate-pulse rounded-md bg-hairline" />
          <div className="h-24 animate-pulse rounded-card bg-hairline" />
        </div>
      )}
      {load.status === 'error' && (
        <div role="alert" className="m-4 rounded-card border border-hairline bg-surface p-4">
          <p className="font-semibold text-critical">The log could not be loaded</p>
          <p className="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-ink-2">{load.message}</p>
        </div>
      )}
      {row !== null && active !== null && (
        <div className="flex flex-col gap-3 p-4" aria-busy={stale}>
          <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Fact label="Service">
              {row.service}
              {(() => {
                const v = row.resource.attributes.get('service.version');
                return v === undefined ? null : (
                  <span className={`${SUB} block`}>{anyValueToDisplay(v)}</span>
                );
              })()}
            </Fact>
            <Fact label="Host">{row.host ?? '—'}</Fact>
            <Fact label="Scope">
              {row.scope.name === '' ? '—' : row.scope.name}
              {row.scope.version !== '' && <span className={`${SUB} block`}>{row.scope.version}</span>}
            </Fact>
            <Fact label="Trace">
              <TraceFact traceId={row.log.traceId} spanId={row.log.spanId} presence={presence} />
            </Fact>
          </dl>
          <section aria-label="Body" className="rounded-card border border-hairline bg-surface p-3">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="mr-auto text-xs font-semibold tracking-wide text-ink-2 uppercase">Body</h2>
              <fieldset className="flex items-center gap-1 rounded-full border border-hairline p-0.5">
                <legend className="sr-only">Body layout</legend>
                {(['raw', 'wrapped'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={bodyMode === m}
                    onClick={() => setBodyMode(m)}
                    className={`${TOGGLE} ${bodyMode === m ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-hairline'}`}
                  >
                    {m === 'raw' ? 'Raw' : 'Wrapped'}
                  </button>
                ))}
              </fieldset>
              <CopyBody body={row.log.body} />
            </div>
            <LogBody body={row.log.body} mode={bodyMode} lines={1000} />
          </section>
          <Tabs.Root
            value={active}
            onValueChange={(v) => {
              if (typeof v === 'string' && isLogTabId(v)) sel.setTab('log', v);
            }}
          >
            <Tabs.List aria-label="Log views" className="flex flex-wrap gap-1 pb-2">
              {tabs.map((t) => (
                <Tabs.Tab key={t.id} value={t.id} className={TAB_BASE}>
                  {t.label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <Tabs.Panel value={active} className="p-1 outline-none">
              {body(row, active)}
            </Tabs.Panel>
          </Tabs.Root>
        </div>
      )}
    </aside>
  );
}
