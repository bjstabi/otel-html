import { ChevronDown, ChevronRight } from 'lucide-react';
import { type JSX, useMemo, useRef, useState } from 'react';
import { parseTraceId, parseUnixNanos, type RelNanos, type SpanId } from '../../model/ids.js';
import { formatDuration, formatTime } from '../../semconv/formatters.js';
import type { DataSource, TraceDetail } from '../data/data-source.js';
import type { TraceNode } from '../data/trace-tree.js';
import { jobStatus, resultStatus } from './derive.js';
import type { CiJob, CiRun } from './runs.js';

const STEP_RESULT = 'cicd.pipeline.task.step.result';
const MISE_TASK = 'mise.task.name';
const MISE_SKIPPED = 'mise.task.skipped';
const QUEUED = 'queued';
const LINE_PX = 24;
const LABEL_REM = 14;
const PANE_CHROME_PX = 10;
const ROW_PITCH_PX = 30;

/** The pane's height in grid rows (20 px rows, 10 px gaps) for content `contentPx` tall, plus 10 px of padding. */
export function runPaneRows(contentPx: number): number {
  return Math.max(1, Math.ceil((contentPx + PANE_CHROME_PX) / ROW_PITCH_PX));
}

const BAR = {
  success: 'bg-good',
  failure: 'bg-critical',
  cancelled: 'bg-series-other',
} as const;
const HATCH = 'repeating-linear-gradient(135deg, currentColor 0 2px, transparent 2px 5px)' as const;

type Status = keyof typeof BAR | 'skipped' | 'unknown';

type Load =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; detail: TraceDetail }
  | { status: 'error'; message: string };

interface Line {
  key: string;
  kind: 'job' | 'step' | 'task' | 'note';
  depth: number;
  label: string;
  start: number;
  end: number;
  status: Status;
  hatched: boolean;
  /** The row can expand. */
  expandable: boolean;
  expanded: boolean;
  /** Toggles the row's expansion. */
  toggle?: () => void;
  queueFrom?: number;
  last?: boolean;
  note?: { text: string; alert: boolean };
}

function stepStatus(node: TraceNode): Status {
  const v = node.row.span.attributes.get(STEP_RESULT);
  if (v?.kind !== 'string') return 'unknown';
  return resultStatus(v.value) ?? 'skipped';
}

/** The spans below `node` that are mise tasks (they name a task), in start order. */
function taskNodes(node: TraceNode): TraceNode[] {
  const out: TraceNode[] = [];
  const walk = (n: TraceNode): void => {
    for (const c of n.children) {
      if (c.row.span.attributes.has(MISE_TASK)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out.sort((a, b) => a.row.span.start - b.row.span.start);
}

const isSkipped = (n: TraceNode): boolean => {
  const v = n.row.span.attributes.get(MISE_SKIPPED);
  return v?.kind === 'bool' && v.value;
};

function jobKey(j: CiJob, i: number): string {
  return j.spanId ?? `${i}/${j.name}`;
}

/** The job whose rows are the Gantt's: the one that finished last among those that ran. */
function lastToFinish(jobs: readonly CiJob[]): number {
  let at = -1;
  jobs.forEach((j, i) => {
    if (jobStatus(j) === null) return;
    if (at === -1 || j.end > (jobs[at]?.end ?? 0)) at = i;
  });
  return at;
}

function SummaryLine(props: { run: CiRun; epoch: ReturnType<typeof parseUnixNanos> }): JSX.Element {
  const { run, epoch } = props;
  const counted = run.replayed + run.ran;
  const parts = [
    `${run.branch ?? 'no branch'}${run.revision === null ? '' : ` @ ${run.revision.slice(0, 7)}`}`,
    run.trigger ?? 'no trigger',
    formatTime(run.start as RelNanos, epoch),
    run.result,
    formatDuration(run.duration),
    `${run.jobs.length} ${run.jobs.length === 1 ? 'job' : 'jobs'}`,
    `${run.minutes.toFixed(1)} CI min`,
    counted === 0 ? 'no cache data' : `${run.replayed} of ${counted} tasks replayed`,
  ];
  return (
    <p data-testid="run-summary" className="font-mono text-xs text-ink-2">
      {parts.join(' · ')}
    </p>
  );
}

/**
 * The open run: a summary line and a Gantt of its jobs (queue hatched before each bar, result colours, the last job
 * to finish outlined with a dashed line at its end, `needs` edges). A job expands to its steps, read with one
 * `getTrace` on the first expansion; a step with mise tasks under it expands to them, replayed ones hatched. Key it
 * by the run's trace: it keeps what it loaded.
 */
export function RunGantt(props: { run: CiRun; dataSource: DataSource }): JSX.Element {
  const { run, dataSource } = props;
  const epoch = useMemo(
    () => parseUnixNanos(dataSource.manifest.epochUnixNano, 'manifest.epochUnixNano'),
    [dataSource],
  );
  const [load, setLoad] = useState<Load>({ status: 'idle' });
  const requested = useRef(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const toggle = (key: string, loads: boolean): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
    if (!loads || requested.current) return;
    requested.current = true;
    setLoad({ status: 'loading' });
    dataSource.getTrace(parseTraceId(run.traceId, 'trace')).then(
      (detail) => setLoad({ status: 'ready', detail }),
      (e: unknown) => setLoad({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
  };

  const t0 = run.start;
  const span = Math.max(1, run.duration);
  const pct = (t: number): number => Math.min(100, Math.max(0, ((t - t0) / span) * 100));
  const last = lastToFinish(run.jobs);

  const lines: Line[] = [];
  const rowOf = new Map<CiJob, number>();
  run.jobs.forEach((j, i) => {
    const key = jobKey(j, i);
    const expanded = open.has(key);
    rowOf.set(j, lines.length);
    lines.push({
      key,
      kind: 'job',
      depth: 0,
      label: j.name,
      start: j.start,
      end: j.end,
      status: jobStatus(j) ?? 'skipped',
      hatched: false,
      expandable: j.spanId !== null,
      expanded,
      toggle: () => toggle(key, true),
      ...(j.queuedNs !== null && j.queuedNs > 0 ? { queueFrom: j.start - j.queuedNs } : {}),
      last: i === last,
    });
    if (!expanded) return;
    if (load.status !== 'ready') {
      lines.push({
        key: `${key}/note`,
        kind: 'note',
        depth: 1,
        label: '',
        start: 0,
        end: 0,
        status: 'unknown',
        hatched: false,
        expandable: false,
        expanded: false,
        note:
          load.status === 'error'
            ? { text: `The steps could not be loaded: ${load.message}`, alert: true }
            : { text: 'Loading steps…', alert: false },
      });
      return;
    }
    const node = j.spanId === null ? undefined : load.detail.tree.byId.get(j.spanId as SpanId);
    const steps = (node?.children ?? []).filter((c) => c.row.span.name !== QUEUED);
    if (steps.length === 0) {
      lines.push({
        key: `${key}/none`,
        kind: 'note',
        depth: 1,
        label: '',
        start: 0,
        end: 0,
        status: 'unknown',
        hatched: false,
        expandable: false,
        expanded: false,
        note: { text: 'This job has no steps in the trace.', alert: false },
      });
    }
    for (const step of steps) {
      const tasks = taskNodes(step);
      const stepKey = `${key}/${step.row.span.spanId}`;
      const stepOpen = open.has(stepKey);
      lines.push({
        key: stepKey,
        kind: 'step',
        depth: 1,
        label: step.row.span.name,
        start: step.row.span.start,
        end: step.row.span.end,
        status: stepStatus(step),
        hatched: false,
        expandable: tasks.length > 0,
        expanded: stepOpen,
        toggle: () => toggle(stepKey, false),
      });
      if (!stepOpen) continue;
      for (const t of tasks) {
        const name = t.row.span.attributes.get(MISE_TASK);
        lines.push({
          key: `${stepKey}/${t.row.span.spanId}`,
          kind: 'task',
          depth: 2,
          label: name?.kind === 'string' ? name.value : t.row.span.name,
          start: t.row.span.start,
          end: t.row.span.end,
          status: 'unknown',
          hatched: isSkipped(t),
          expandable: false,
          expanded: false,
        });
      }
    }
  });

  const total = lines.length * LINE_PX;
  const edges = run.jobs.flatMap((to) =>
    to.needs.length === 0
      ? []
      : run.jobs
          .filter((from) => from !== to && from.id !== null && to.needs.includes(from.id))
          .map((from) => ({ from, to })),
  );
  const endAt = last === -1 ? null : (run.jobs[last]?.end ?? null);

  return (
    <div className="flex flex-col gap-2" data-testid="run-gantt">
      <SummaryLine run={run} epoch={epoch} />
      <div className="relative" style={{ height: total }}>
        <div className="absolute inset-0">
          {lines.map((l) => (
            <GanttLine key={l.key} line={l} pct={pct} />
          ))}
        </div>
        <svg
          aria-hidden
          className="pointer-events-none absolute top-0 text-muted"
          style={{ left: `${LABEL_REM}rem`, width: `calc(100% - ${LABEL_REM}rem)`, height: total }}
          viewBox={`0 0 1000 ${Math.max(1, total)}`}
          preserveAspectRatio="none"
        >
          {endAt !== null && (
            <line
              data-end-line
              x1={pct(endAt) * 10}
              x2={pct(endAt) * 10}
              y1={0}
              y2={total}
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {edges.map(({ from, to }) => {
            const a = rowOf.get(from);
            const b = rowOf.get(to);
            if (a === undefined || b === undefined) return null;
            const x1 = pct(from.end) * 10;
            const x2 = pct(to.start) * 10;
            const y1 = a * LINE_PX + LINE_PX / 2;
            const y2 = b * LINE_PX + LINE_PX / 2;
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={`${from.spanId ?? from.name}>${to.spanId ?? to.name}`}
                data-edge={`${from.name}>${to.name}`}
                d={`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function GanttLine(props: { line: Line; pct: (t: number) => number }): JSX.Element {
  const { line: l, pct } = props;
  const indent = `${l.depth * 1}rem`;
  if (l.kind === 'note') {
    return (
      <div
        style={{ height: LINE_PX, paddingLeft: `calc(${indent} + 1rem)` }}
        role={l.note?.alert === true ? 'alert' : 'status'}
        className={`flex items-center text-xs ${l.note?.alert === true ? 'text-critical' : 'text-muted'}`}
      >
        {l.note?.text}
      </div>
    );
  }
  const left = pct(l.start);
  const width = Math.max(0, pct(l.end) - left);
  const color =
    l.status === 'success' || l.status === 'failure' || l.status === 'cancelled'
      ? BAR[l.status]
      : l.kind === 'task'
        ? 'bg-accent'
        : 'bg-series-other';
  const attrs: Record<string, string> = {};
  if (l.kind === 'job') attrs['data-job-row'] = l.label;
  if (l.kind === 'step') attrs['data-step-row'] = l.label;
  if (l.kind === 'task') {
    attrs['data-task'] = l.label;
    attrs['data-replayed'] = String(l.hatched);
  }
  const Chevron = l.expanded ? ChevronDown : ChevronRight;
  return (
    <div {...attrs} className="flex items-center" style={{ height: LINE_PX }}>
      <div
        className="flex shrink-0 items-center overflow-hidden pr-2 text-xs"
        style={{ width: `${LABEL_REM}rem`, paddingLeft: indent }}
      >
        {l.expandable ? (
          <button
            type="button"
            aria-expanded={l.expanded}
            title={l.label}
            onClick={l.toggle}
            className="flex min-w-0 items-center gap-1 text-left text-ink"
          >
            <Chevron size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{l.label}</span>
          </button>
        ) : (
          <span className="truncate pl-4 text-ink-2" title={l.label}>
            {l.label}
          </span>
        )}
      </div>
      <div className="relative h-full flex-1">
        {l.queueFrom !== undefined && (
          <span
            data-queue
            title="Queued"
            className="absolute top-2 bottom-2 text-series-other opacity-70"
            style={{
              left: `${pct(l.queueFrom)}%`,
              width: `${Math.max(0, left - pct(l.queueFrom))}%`,
              backgroundImage: HATCH,
            }}
          />
        )}
        <span
          data-bar
          data-result={l.status}
          data-last={l.last === true ? 'true' : undefined}
          title={`${l.label}: ${formatDuration(Math.max(0, l.end - l.start))}`}
          className={`absolute top-1.5 bottom-1.5 rounded-sm ${l.hatched ? 'text-accent' : color} ${l.last === true ? 'outline-2 outline-offset-1 outline-ink' : ''}`}
          style={{
            left: `${left}%`,
            width: `max(3px, ${width}%)`,
            ...(l.hatched ? { backgroundColor: 'transparent', backgroundImage: HATCH } : {}),
          }}
        />
      </div>
    </div>
  );
}
