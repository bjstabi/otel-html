import { parseArgs } from 'node:util';
import type { ApiJob } from './context.js';
import type { JobId } from './ids.js';

export type PublishOptions = {
  runId: number;
  repository: string;
  artifacts: string;
  out: string;
  config: string | undefined;
};

/** Parses the publisher's command line; throws a message naming the first problem. */
export function parsePublishArgs(argv: string[]): PublishOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'run-id': { type: 'string' },
      repository: { type: 'string' },
      artifacts: { type: 'string' },
      out: { type: 'string' },
      config: { type: 'string' },
    },
    strict: true,
  });
  const need = (name: 'run-id' | 'repository' | 'artifacts' | 'out'): string => {
    const v = values[name];
    if (v === undefined || v === '') throw new Error(`--${name} is required`);
    return v;
  };
  const runId = Number(need('run-id'));
  if (!Number.isInteger(runId) || runId <= 0)
    throw new Error(`--run-id is not a positive integer: ${values['run-id']}`);
  const repository = need('repository');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository))
    throw new Error(`--repository is not owner/repo: ${repository}`);
  return { runId, repository, artifacts: need('artifacts'), out: need('out'), config: values.config };
}

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
