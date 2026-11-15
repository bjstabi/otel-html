import type { ApiJob, ApiRun } from './github-api.js';

/**
 * The run as it will look once the jobs named by `excludePrefix` (the ones doing this report) are gone: those jobs
 * dropped and, when the run is not yet `completed`, the run completed at its latest remaining job's end with the
 * conclusion GitHub gives it: `failure` when a remaining job is `failure`, `timed_out` or `startup_failure`, else
 * `cancelled` when one is `cancelled`, else `success` (a skipped job counts as success). The caller
 * runs after every other job finished, so no remaining job is unfinished.
 */
export function finishedView(
  run: ApiRun,
  jobs: readonly ApiJob[],
  excludePrefix: string,
): { run: ApiRun; jobs: ApiJob[] } {
  const kept = excludePrefix === '' ? [...jobs] : jobs.filter((j) => !j.name.startsWith(excludePrefix));
  // an empty prefix reports the run as it is
  if (run.status === 'completed' || excludePrefix === '') return { run, jobs: kept };
  const conclusions = kept.map((j) => j.conclusion);
  const conclusion = conclusions.some((c) => c === 'failure' || c === 'timed_out' || c === 'startup_failure')
    ? 'failure'
    : conclusions.includes('cancelled')
      ? 'cancelled'
      : 'success';
  let updated_at = run.updated_at;
  let latest = Number.NEGATIVE_INFINITY;
  for (const j of kept) {
    const end = j.completed_at === null ? Number.NaN : Date.parse(j.completed_at);
    if (end > latest) {
      latest = end;
      updated_at = j.completed_at ?? updated_at;
    }
  }
  return { run: { ...run, status: 'completed', conclusion, updated_at }, jobs: kept };
}
