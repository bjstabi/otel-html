import type { CicdRow } from '../data/cicd-query.js';

/** One job of a run. */
export interface CiJob {
  name: string;
  id: string | null;
  result: string;
  start: number;
  end: number;
  queuedNs: number | null;
  labels: string | null;
  needs: string[];
  condition: string | null;
  failedStep: string | null;
  spanId: string | null;
}

/** One run (a run id, by its latest attempt). Times are run-relative ns. */
export interface CiRun {
  traceId: string;
  runId: string;
  attempt: number;
  /** How many attempts of this run id the rows held. */
  attempts: number;
  start: number;
  /** The latest job end minus the run's start; the root span's own length when the run has no job row. */
  duration: number;
  result: 'success' | 'failure' | 'cancelled';
  trigger: string | null;
  branch: string | null;
  revision: string | null;
  title: string | null;
  jobs: CiJob[];
  /** The sum of the job durations, in minutes. */
  minutes: number;
  replayed: number;
  ran: number;
  /** Null when no task was counted, else whether any was replayed. */
  cached: boolean | null;
}

const NS_PER_MINUTE = 60_000_000_000;

function resultOf(result: string | null): CiRun['result'] {
  if (result === 'success') return 'success';
  return result === 'cancellation' ? 'cancelled' : 'failure';
}

interface Trace {
  run: CicdRow | null;
  jobs: Map<string, CicdRow>;
  replayed: number;
  ran: number;
}

function jobOf(r: CicdRow): CiJob {
  return {
    name: r.task ?? r.name ?? '',
    id: r.taskId,
    result: r.result ?? '',
    start: r.start,
    end: r.end,
    queuedNs: r.queuedNs,
    labels: r.labels,
    needs: r.needs ?? [],
    condition: r.condition,
    failedStep: r.failedStep,
    spanId: r.spanId,
  };
}

function runOf(traceId: string, t: Trace & { run: CicdRow }, attempts: number): CiRun {
  const jobs = [...t.jobs.values()].map(jobOf).sort((a, b) => a.start - b.start || a.end - b.end);
  const end = jobs.length === 0 ? t.run.end : Math.max(...jobs.map((j) => j.end));
  const counted = t.replayed + t.ran;
  return {
    traceId,
    runId: t.run.runId ?? traceId,
    attempt: t.run.attempt ?? 1,
    attempts,
    start: t.run.start,
    duration: Math.max(0, end - t.run.start),
    result: resultOf(t.run.result),
    trigger: t.run.trigger,
    branch: t.run.branch,
    revision: t.run.revision,
    title: t.run.title,
    jobs,
    minutes: jobs.reduce((sum, j) => sum + Math.max(0, j.end - j.start), 0) / NS_PER_MINUTE,
    replayed: t.replayed,
    ran: t.ran,
    cached: counted === 0 ? null : t.replayed > 0,
  };
}

/**
 * Joins `cicd` rows into runs. Rows are joined by trace (a run's rows may come from several partitions): the task counts
 * of its `tasks` rows are summed, a run or job row seen twice keeps the later-ending one. Each run id keeps its latest
 * attempt (a later start breaks a tie), and `attempts` counts the traces it was seen in. A trace with no run row is not a
 * run. Sorted by start.
 */
export function combineRuns(rows: readonly CicdRow[]): CiRun[] {
  const traces = new Map<string, Trace>();
  for (const r of rows) {
    const t = traces.get(r.traceId) ?? { run: null, jobs: new Map<string, CicdRow>(), replayed: 0, ran: 0 };
    traces.set(r.traceId, t);
    if (r.kind === 'run') {
      if (t.run === null || r.end > t.run.end) t.run = r;
    } else if (r.kind === 'job') {
      const key = r.spanId ?? `${r.start}/${r.task ?? ''}`;
      const prior = t.jobs.get(key);
      if (prior === undefined || r.end > prior.end) t.jobs.set(key, r);
    } else {
      t.replayed += r.tasksReplayed ?? 0;
      t.ran += r.tasksRun ?? 0;
    }
  }
  const byRunId = new Map<string, { traceId: string; trace: Trace & { run: CicdRow }; seen: number }>();
  for (const [traceId, t] of traces) {
    if (t.run === null) continue;
    const trace = { ...t, run: t.run };
    const id = t.run.runId ?? traceId;
    const prior = byRunId.get(id);
    if (prior === undefined) {
      byRunId.set(id, { traceId, trace, seen: 1 });
      continue;
    }
    const later =
      (trace.run.attempt ?? 1) > (prior.trace.run.attempt ?? 1) ||
      ((trace.run.attempt ?? 1) === (prior.trace.run.attempt ?? 1) &&
        trace.run.start > prior.trace.run.start);
    byRunId.set(id, later ? { traceId, trace, seen: prior.seen + 1 } : { ...prior, seen: prior.seen + 1 });
  }
  return [...byRunId.values()]
    .map((v) => runOf(v.traceId, v.trace, v.seen))
    .sort((a, b) => a.start - b.start || (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0));
}
