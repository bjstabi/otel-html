import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { contextEnv, contextJson, envFileText, readInputs, resolveJob } from './ci/context.js';
import { type ApiJob, fetchJobs, messageOf, warning } from './ci/github-api.js';

/**
 * Job-side CI context: appends TRACEPARENT, OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME to $GITHUB_ENV so later
 * steps (and `otel-html run`) join the workflow run's trace, and writes .otel-html/context.json for the publisher.
 * Never fails the job: any problem is a `::warning::` and exit 0.
 *
 *   bun scripts/ci-context.ts
 */
const warn = (message: string): void => warning('context', message);
const JOBS_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const inputs = readInputs(process.env);
  let jobs: ApiJob[] = [];
  if (inputs.token === undefined) {
    warn('GITHUB_TOKEN is not set; using the job name for the span id');
  } else {
    try {
      jobs = await fetchJobs(inputs, inputs.token, JOBS_TIMEOUT_MS);
    } catch (e) {
      warn(messageOf(e));
    }
  }
  const resolved = resolveJob(jobs, inputs.runnerName, inputs.jobNameHint);
  const apiName = jobs.find((j) => j.id === resolved.jobId)?.name;
  if (resolved.approximate) {
    warn(
      `could not tell which job this is; using the name ${inputs.jobNameHint} for its span id. Set OTEL_HTML_JOB_NAME to the job's display name (matrix legs share GITHUB_JOB, so their fallback ids would collide).`,
    );
  }
  const env = contextEnv({ ...inputs, jobName: apiName ?? inputs.jobNameHint, jobId: resolved.jobId });
  appendFileSync(inputs.envFile, envFileText(env));
  mkdirSync('.otel-html', { recursive: true });
  writeFileSync('.otel-html/context.json', contextJson(resolved));
}

main().catch((e: unknown) => {
  warn(messageOf(e));
});
