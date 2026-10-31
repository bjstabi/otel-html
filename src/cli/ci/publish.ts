import type { ApiJob } from './github-api.js';
import type { JobId } from './ids.js';

/** The `context.json` a job artifact carries, or undefined when the text is missing or malformed. */
export function parseJobContext(
  text: string | undefined,
): { jobId: JobId; approximate: boolean } | undefined {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null) return undefined;
    const o = v as { jobId?: unknown; approximate?: unknown };
    if (typeof o.approximate !== 'boolean') return undefined;
    if (typeof o.jobId !== 'number' && typeof o.jobId !== 'string') return undefined;
    return { jobId: o.jobId, approximate: o.approximate };
  } catch {
    return undefined;
  }
}

/** The API jobs no artifact claimed with an exact (numeric) id: their ids fall back to the name hash on both sides. */
export function approximateJobs(
  jobs: readonly ApiJob[],
  contexts: readonly ({ jobId: JobId; approximate: boolean } | undefined)[],
): Set<number> {
  const claimed = new Set<number>();
  for (const c of contexts)
    if (c !== undefined && !c.approximate && typeof c.jobId === 'number') claimed.add(c.jobId);
  return new Set(jobs.map((j) => j.id).filter((id) => !claimed.has(id)));
}

/** The id the trace uses for a job: its API id, or `name:<job name>` when approximate. */
export const jobIdFor = (job: ApiJob, approximate: ReadonlySet<number>): JobId =>
  approximate.has(job.id) ? `name:${job.name}` : job.id;
