import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { CliIo } from '../io.js';
import { contextEnv, contextJson, envFileText, readInputs, resolveJob } from './context.js';
import { type ApiJob, type Fetch, fetchJobs, messageOf, warning } from './github-api.js';

const JOBS_TIMEOUT_MS = 10_000;

/**
 * Job-side CI context: appends TRACEPARENT, OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME to $GITHUB_ENV so later
 * steps (and `otel-html run`) join the workflow run's trace, and writes .otel-html/context.json for the publisher.
 * Never fails the job: any problem is a `::warning::` on stdout and a normal return.
 */
export async function runContext(
  env: Record<string, string | undefined>,
  io: CliIo,
  fetchFn: Fetch = fetch,
): Promise<void> {
  const warn = (message: string): void => warning(io, 'context', message);
  try {
    const inputs = readInputs(env);
    let jobs: ApiJob[] = [];
    if (inputs.token === undefined) {
      warn('GITHUB_TOKEN is not set; using the job name for the span id');
    } else {
      try {
        jobs = await fetchJobs(inputs, inputs.token, JOBS_TIMEOUT_MS, fetchFn);
      } catch (e) {
        warn(messageOf(e));
      }
    }
    const resolved = resolveJob(jobs, inputs.runnerName, inputs.jobNameHint);
    const apiName = jobs.find((j) => j.id === resolved.jobId)?.name;
    if (resolved.approximate) {
      warn(
        `could not tell which job this is; using the name ${inputs.jobNameHint} for its span id. Set OTEL_HTML_JOB_NAME (or --job-name) to the job's display name (matrix legs share GITHUB_JOB, so their fallback ids would collide).`,
      );
    }
    const ctx = contextEnv({ ...inputs, jobName: apiName ?? inputs.jobNameHint, jobId: resolved.jobId });
    appendFileSync(inputs.envFile, envFileText(ctx));
    mkdirSync('.otel-html', { recursive: true });
    writeFileSync('.otel-html/context.json', contextJson(resolved));
  } catch (e) {
    warn(messageOf(e));
  }
}
