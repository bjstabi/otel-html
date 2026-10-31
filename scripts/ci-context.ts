import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  type ApiJob,
  contextEnv,
  contextJson,
  envFileText,
  jobsUrl,
  parseNextLink,
  readInputs,
  resolveJob,
} from './ci/context.js';

/**
 * Job-side CI context: appends TRACEPARENT, OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME to $GITHUB_ENV so later
 * steps (and `otel-html run`) join the workflow run's trace, and writes .otel-html/context.json for the publisher.
 * Never fails the job: any problem is a `::warning::` and exit 0.
 *
 *   bun scripts/ci-context.ts
 */
const warn = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

async function fetchJobs(first: string, token: string): Promise<ApiJob[]> {
  const jobs: ApiJob[] = [];
  let next: string | undefined = first;
  while (next !== undefined) {
    const res = await fetch(next, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${next} answered ${res.status}`);
    const body = (await res.json()) as { jobs?: ApiJob[] };
    jobs.push(...(body.jobs ?? []));
    next = parseNextLink(res.headers.get('link'));
  }
  return jobs;
}

async function main(): Promise<void> {
  const inputs = readInputs(process.env);
  let jobs: ApiJob[] = [];
  if (inputs.token === undefined) {
    warn('::warning::otel-html context: GITHUB_TOKEN is not set; using the job name for the span id');
  } else {
    try {
      jobs = await fetchJobs(jobsUrl(inputs), inputs.token);
    } catch (e) {
      warn(`::warning::otel-html context: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const resolved = resolveJob(jobs, inputs.runnerName, inputs.jobNameHint);
  const apiName = jobs.find((j) => j.id === resolved.jobId)?.name;
  if (resolved.approximate) {
    warn(
      `::warning::otel-html context: could not tell which job this is; using the name ${inputs.jobNameHint} for its span id. Set OTEL_HTML_JOB_NAME to the job's display name (matrix legs share GITHUB_JOB, so their fallback ids would collide).`,
    );
  }
  const env = contextEnv({ ...inputs, jobName: apiName ?? inputs.jobNameHint, jobId: resolved.jobId });
  appendFileSync(inputs.envFile, envFileText(env));
  mkdirSync('.otel-html', { recursive: true });
  writeFileSync('.otel-html/context.json', contextJson(resolved));
}

main().catch((e: unknown) => {
  warn(`::warning::otel-html context: ${e instanceof Error ? e.message : String(e)}`);
});
