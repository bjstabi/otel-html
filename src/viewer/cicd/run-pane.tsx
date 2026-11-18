import { X } from 'lucide-react';
import { type JSX, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Widget } from '../../dashboards/schema.js';
import type { WidgetScope } from '../dashboards/scope.js';
import type { DataSource } from '../data/data-source.js';
import { useRunActions } from './run-actions.js';
import { RunGantt, runPaneRows } from './run-gantt.js';
import type { CiRun } from './runs.js';
import { useCicd } from './use-cicd.js';

const OUTSIDE_SELECTION = 'The run is outside the current selection';

type OpenRun =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'outside' }
  | { status: 'ready'; run: CiRun };

/** The open run among the runs of the widget it was opened from (under that widget's current selection). */
function useOpenRun(widget: Widget, scope: Pick<WidgetScope, 'window' | 'vars'>, traceId: string): OpenRun {
  const data = useCicd(widget, scope);
  // while the source view reloads, the last run stays (the Gantt keeps its expansions)
  const last = useRef<CiRun | null>(null);
  if (data.status === 'loading')
    return last.current?.traceId === traceId ? { status: 'ready', run: last.current } : { status: 'loading' };
  if (data.status === 'error') return { status: 'error', message: data.error?.message ?? 'unknown error' };
  const run = data.runs.find((r) => r.traceId === traceId);
  last.current = run ?? null;
  return run === undefined ? { status: 'outside' } : { status: 'ready', run };
}

/** The run's content for a surface that has no frame of its own (the trace panel's Jobs tab). */
export function OpenRunBody(props: {
  widget: Widget;
  scope: Pick<WidgetScope, 'window' | 'vars'>;
  traceId: string;
  dataSource: DataSource;
}): JSX.Element {
  const open = useOpenRun(props.widget, props.scope, props.traceId);
  const actions = useRunActions(props.widget.id);
  return (
    <>
      <button
        type="button"
        className="mb-2 rounded-full border border-hairline px-2 py-0.5 text-xs text-ink-2 hover:bg-hairline"
        onClick={() => actions.setMode('attached')}
      >
        opens: attached / <b className="text-ink">side panel</b>
      </button>
      <RunState open={open} dataSource={props.dataSource} />
    </>
  );
}

function RunState(props: { open: OpenRun; dataSource: DataSource }): JSX.Element {
  const { open, dataSource } = props;
  switch (open.status) {
    case 'loading':
      return (
        <p role="status" className="p-3 text-sm text-muted">
          Loading the run…
        </p>
      );
    case 'error':
      return (
        <p role="alert" className="p-3 text-sm text-critical">
          The run could not be read: {open.message}
        </p>
      );
    case 'outside':
      return <p className="p-3 text-sm text-ink-2">{OUTSIDE_SELECTION}</p>;
    case 'ready':
      return <RunGantt key={open.run.traceId} run={open.run} dataSource={dataSource} />;
  }
}

export interface RunPaneProps {
  widget: Widget;
  scope: Pick<WidgetScope, 'window' | 'vars'>;
  traceId: string;
  dataSource: DataSource;
  /** Pane height in px (the grid's). */
  heightPx: number;
  /** Reports the rows the content needs; the page lets the grid grow or shrink to it. */
  onRows(rows: number): void;
  onClose(): void;
}

/**
 * The attached frame: a header (run title, the "opens: attached" pill, ✕), a caret on the top edge pointing at the
 * source widget (hidden when the run is outside its selection), and the shared content. The content is measured
 * after render and its height reported in grid rows.
 */
export function RunPane(props: RunPaneProps): JSX.Element {
  const { widget, scope, traceId, dataSource, heightPx, onRows, onClose } = props;
  const actions = useRunActions(widget.id);
  const section = useRef<HTMLElement>(null);
  const [caretAt, setCaretAt] = useState(0.5);
  const x = actions.runPoint?.x;
  // the caret sits over the mark: the source widget's measured left edge plus the mark's share of its width
  useLayoutEffect(() => {
    const place = (): void => {
      const pane = section.current?.getBoundingClientRect();
      const src = document.querySelector(`[data-widget="${CSS.escape(widget.id)}"]`)?.getBoundingClientRect();
      const known =
        x !== undefined && pane !== undefined && src !== undefined && pane.width > 0 && src.width > 0;
      setCaretAt(known ? Math.min(1, Math.max(0, (src.left - pane.left + x * src.width) / pane.width)) : 0.5);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [widget.id, x]);
  const open = useOpenRun(widget, scope, traceId);
  const content = useRef<HTMLDivElement>(null);
  const report = useRef(onRows);
  report.current = onRows;
  useEffect(() => {
    const el = content.current;
    if (el === null) return;
    const measure = (): void => report.current(runPaneRows(el.offsetHeight));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const title = open.status === 'ready' ? (open.run.title ?? `Run ${open.run.runId}`) : 'Run';
  return (
    <section
      ref={section}
      aria-label="Open run"
      data-testid="run-pane"
      className="relative flex flex-col overflow-auto rounded-card border border-hairline bg-surface"
      style={{ height: heightPx }}
    >
      {open.status !== 'outside' && (
        <span
          data-testid="run-caret"
          aria-hidden
          className="absolute -top-1.5 size-3 -translate-x-1/2 rotate-45 border-t border-l border-hairline bg-surface"
          style={{ left: `${caretAt * 100}%` }}
        />
      )}
      <div ref={content} className="flex shrink-0 flex-col">
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <h2 className="mr-auto min-w-0 truncate text-sm font-semibold">{title}</h2>
          <button
            type="button"
            className="rounded-full border border-hairline px-2 py-0.5 text-xs text-ink-2 hover:bg-hairline"
            onClick={() => actions.setMode('panel')}
          >
            opens: <b className="text-ink">attached</b> / side panel
          </button>
          <button
            type="button"
            aria-label="Close the run"
            className="rounded-full p-1 hover:bg-hairline"
            onClick={onClose}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="p-3">
          <RunState open={open} dataSource={dataSource} />
        </div>
      </div>
    </section>
  );
}

/**
 * The dotted connector from the open run's mark down to the bottom edge of its source widget: drawn in the widget's
 * frame, only while the run is attached and still in the view. Nothing draws when the mark's point is unknown.
 */
export function RunConnector(props: {
  widget: Widget;
  scope: Pick<WidgetScope, 'window' | 'vars'>;
  traceId: string;
}): JSX.Element | null {
  const open = useOpenRun(props.widget, props.scope, props.traceId);
  const { runPoint } = useRunActions(props.widget.id);
  if (open.status !== 'ready' || runPoint === null) return null;
  return (
    <span
      data-testid="run-connector"
      aria-hidden
      className="pointer-events-none absolute bottom-0 border-l-[1.5px] border-dotted border-accent"
      style={{ left: `${runPoint.x * 100}%`, top: `${runPoint.y * 100}%` }}
    />
  );
}
