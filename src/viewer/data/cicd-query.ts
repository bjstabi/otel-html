import type { ManifestV4 } from '../../format/manifest.js';
import type { ColumnBatch } from '../../format/parquet/batch.js';
import {
  type CicdRunColumn,
  type CicdSelection,
  cicdRowsQuery,
  cicdSpansQuery,
} from '../../query/sql/cicd.js';
import { absWindow } from '../../query/sql/prune.js';
import { CicdRowSet } from '../../writer/cicd-rows.js';
import { filesFor, runPrepared, throwIfAborted } from './query-common.js';
import type { QueryEngine } from './query-engine.js';
import { cell, rowsOf } from './span-results.js';
import type { TimeWindow } from './time-window.js';

/** The CI keys a variable binding of a `cicd` view can narrow the fetch by (spec §4.3): the run-level ones. */
const BINDING_COLUMN: Readonly<Record<string, CicdRunColumn>> = {
  'vcs.ref.head.name': 'branch',
  'cicd.pipeline.trigger': 'trigger',
};

/** One row of the `cicd` table: a run, a job, or the task counts of one trace in one partition. `start` and `end` are run-relative ns. */
export interface CicdRow {
  kind: 'run' | 'job' | 'tasks';
  traceId: string;
  spanId: string | null;
  start: number;
  end: number;
  name: string | null;
  result: string | null;
  pipeline: string | null;
  runId: string | null;
  attempt: number | null;
  trigger: string | null;
  branch: string | null;
  revision: string | null;
  title: string | null;
  task: string | null;
  taskId: string | null;
  labels: string | null;
  queuedNs: number | null;
  needs: string[] | null;
  condition: string | null;
  failedStep: string | null;
  tasksReplayed: number | null;
  tasksRun: number | null;
}

/** What `DataSource.cicdRows` is asked: the runs starting in `window`, narrowed by the run-level bindings and `pipeline`. */
export interface CicdQuery {
  window: TimeWindow | null;
  /** All the page's variables; only the branch and trigger keys narrow the fetch, the others are ignored here. */
  bindings: readonly { key: string; value: string }[];
  pipeline: string | null;
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const whole = (v: unknown): number | null =>
  typeof v === 'bigint' ? Number(v) : typeof v === 'number' && Number.isFinite(v) ? v : null;
const rel = (v: unknown, epoch: bigint): number => {
  if (typeof v === 'bigint') return Number(v - epoch);
  return typeof v === 'number' ? v - Number(epoch) : 0;
};

function needsOf(v: unknown): string[] | null {
  if (typeof v !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

/** A row of the table (a decoded Parquet row, or a result row of the `cicd` view) as a `CicdRow`. */
function rowOf(r: Readonly<Record<string, unknown>>, epoch: bigint): CicdRow {
  const kind = cell(r, 'kind');
  return {
    kind: kind === 'run' || kind === 'job' ? kind : 'tasks',
    traceId: String(cell(r, 'trace_id')),
    spanId: text(cell(r, 'span_id')),
    start: rel(cell(r, 'start_ns'), epoch),
    end: rel(cell(r, 'end_ns'), epoch),
    name: text(cell(r, 'name')),
    result: text(cell(r, 'result')),
    pipeline: text(cell(r, 'pipeline')),
    runId: text(cell(r, 'run_id')),
    attempt: whole(cell(r, 'attempt')),
    trigger: text(cell(r, 'trigger')),
    branch: text(cell(r, 'branch')),
    revision: text(cell(r, 'revision')),
    title: text(cell(r, 'title')),
    task: text(cell(r, 'task')),
    taskId: text(cell(r, 'task_id')),
    labels: text(cell(r, 'labels')),
    queuedNs: whole(cell(r, 'queued_ns')),
    needs: needsOf(cell(r, 'needs')),
    condition: text(cell(r, 'condition')),
    failedStep: text(cell(r, 'failed_step')),
    tasksReplayed: whole(cell(r, 'tasks_replayed')),
    tasksRun: whole(cell(r, 'tasks_run')),
  };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The table's own order: trace id, kind, start, span id. */
function sorted(rows: CicdRow[]): CicdRow[] {
  return rows.sort(
    (a, b) =>
      cmp(a.traceId, b.traceId) ||
      cmp(a.kind, b.kind) ||
      a.start - b.start ||
      cmp(a.spanId ?? '', b.spanId ?? ''),
  );
}

function selectionOf(q: CicdQuery, epoch: bigint): CicdSelection {
  const equals: { column: CicdRunColumn; value: string }[] = [];
  if (q.pipeline !== null) equals.push({ column: 'pipeline', value: q.pipeline });
  for (const b of q.bindings) {
    const column = Object.hasOwn(BINDING_COLUMN, b.key) ? BINDING_COLUMN[b.key] : undefined;
    if (column !== undefined) equals.push({ column, value: b.value });
  }
  return { window: absWindow(q.window, epoch), equals };
}

/** Whether a run row satisfies `sel`, on run-relative times (the window is the absolute one, floored and ceiled). */
function selects(sel: CicdSelection, epoch: bigint, r: CicdRow): boolean {
  if (r.kind !== 'run') return false;
  if (sel.window !== null) {
    const start = BigInt(r.start) + epoch;
    if (start < sel.window.start || start >= sel.window.end) return false;
  }
  return sel.equals.every((e) => r[e.column] === e.value);
}

function spanBatch(rows: ReturnType<typeof rowsOf>): ColumnBatch {
  const names = [
    'trace_id',
    'span_id',
    'parent_span_id',
    'name',
    'start_time_unix_nano',
    'end_time_unix_nano',
    'status_code',
    'attributes',
    'resource_attributes',
    'scope_name',
  ];
  const cells: Record<string, unknown[]> = {};
  for (const n of names) cells[n] = rows.map((r) => cell(r, n) ?? null);
  return { length: rows.length, cells };
}

/**
 * The rows the writer would have stored for the partitions without the `cicd` flag (older, or upgraded): the writer's own
 * derivation (`CicdRowSet`) run over each partition's spans, one partition at a time as the writer does.
 */
async function scanned(
  engine: Pick<QueryEngine, 'prepare' | 'query'>,
  manifest: ManifestV4,
  epoch: bigint,
  signal: AbortSignal | undefined,
): Promise<CicdRow[]> {
  const files = manifest.partitions.flatMap((p) =>
    p.cicd !== true && p.files.spans !== undefined ? [p.files.spans.path] : [],
  );
  if (files.length === 0) return [];
  await engine.prepare(files, signal);
  const parts = await Promise.all(
    files.map(async (path) => {
      throwIfAborted(signal);
      const table = await engine.query(
        cicdSpansQuery({ files: [path], all: false, total: files.length }),
        signal,
      );
      const set = new CicdRowSet();
      const rows = rowsOf(table);
      set.add(spanBatch(rows));
      return set.rows().map((r) => rowOf(r, epoch));
    }),
  );
  return parts.flat();
}

/**
 * The run, job and `tasks` rows of the traces whose run row starts in `q.window` and satisfies the run-level bindings and
 * `q.pipeline`, whatever partition each of their rows is in. Partitions with the `cicd` flag are read from their `cicd`
 * file (every file, whole); the others by a scan of their spans. The rows come in the table's order, run-relative.
 */
export async function readCicdRows(
  deps: { engine: Pick<QueryEngine, 'prepare' | 'query'>; manifest: ManifestV4; epoch: bigint },
  q: CicdQuery,
  signal?: AbortSignal,
): Promise<CicdRow[]> {
  const { engine, manifest, epoch } = deps;
  throwIfAborted(signal);
  const sel = selectionOf(q, epoch);
  const scan = await scanned(engine, manifest, epoch, signal);
  const scanSelected = new Set(scan.filter((r) => selects(sel, epoch, r)).map((r) => r.traceId));
  const stored: CicdRow[] = [];
  const fileSelected = new Set<string>();
  if (manifest.partitions.some((p) => p.files.cicd !== undefined)) {
    const table = await runPrepared(
      engine,
      cicdRowsQuery(sel, [...scanSelected]),
      filesFor(manifest, ['cicd']),
      signal,
    );
    for (const r of rowsOf(table)) {
      stored.push(rowOf(r, epoch));
      if (cell(r, 'selected') === true) fileSelected.add(String(cell(r, 'trace_id')));
    }
  }
  const rows = [...stored, ...scan.filter((r) => scanSelected.has(r.traceId) || fileSelected.has(r.traceId))];
  return sorted(rows);
}
