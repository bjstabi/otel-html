import type { ApiJob } from './github-api.js';
import type { JobId } from './ids.js';

export type JobContext = { jobId: JobId; approximate: boolean; jobName?: string; runner?: string | null };

/** The `context.json` a job artifact carries, or undefined when the text is missing or malformed. */
export function parseJobContext(text: string | undefined): JobContext | undefined {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null) return undefined;
    const o = v as { jobId?: unknown; approximate?: unknown; jobName?: unknown; runner?: unknown };
    if (typeof o.approximate !== 'boolean') return undefined;
    if (typeof o.jobId !== 'number' && typeof o.jobId !== 'string') return undefined;
    const ctx: JobContext = { jobId: o.jobId, approximate: o.approximate };
    if (typeof o.jobName === 'string') ctx.jobName = o.jobName;
    if (typeof o.runner === 'string' || o.runner === null) ctx.runner = o.runner;
    return ctx;
  } catch {
    return undefined;
  }
}

/**
 * The API jobs no artifact claimed with an exact (numeric) id, each with the id the trace uses for it. The id is the
 * one the job side wrote into `context.json`: the approximate context whose `jobName` equals the job's display name
 * or is its prefix before ` (` (a matrix leg), case-insensitively, and whose `runner` is null or the job's runner (a
 * context that records a runner never matches a job on another runner, so a leg whose own context is missing
 * cannot take a sibling's id). When those candidates carry exactly one distinct id it is used verbatim; with none,
 * or still several, the job keeps `name:<display name>`. Contexts without `jobName` (old artifacts) never match.
 * Two legs with one hint that ran one after the other on one runner still share an id, as same-named jobs do.
 */
export function approximateJobIds(
  jobs: readonly ApiJob[],
  contexts: readonly (JobContext | undefined)[],
): ReadonlyMap<number, JobId> {
  const claimed = new Set<number>();
  const approx: (JobContext & { jobName: string })[] = [];
  for (const c of contexts) {
    if (c === undefined) continue;
    if (!c.approximate && typeof c.jobId === 'number') claimed.add(c.jobId);
    else if (c.approximate && c.jobName !== undefined) approx.push({ ...c, jobName: c.jobName });
  }
  const ids = new Map<number, JobId>();
  for (const job of jobs) {
    if (claimed.has(job.id)) continue;
    const display = job.name.toLowerCase();
    const candidates = new Set<JobId>();
    for (const c of approx) {
      const hint = c.jobName.toLowerCase();
      const nameMatches = hint === display || display.startsWith(`${hint} (`);
      const runnerMatches = c.runner === undefined || c.runner === null || c.runner === job.runner_name;
      if (nameMatches && runnerMatches) candidates.add(c.jobId);
    }
    const [only] = candidates;
    ids.set(job.id, candidates.size === 1 && only !== undefined ? only : `name:${job.name}`);
  }
  return ids;
}

/** The id the trace uses for a job: its approximate id from `approximateJobIds`, else its API id. */
export const jobIdFor = (job: ApiJob, approximate: ReadonlyMap<number, JobId>): JobId =>
  approximate.get(job.id) ?? job.id;
