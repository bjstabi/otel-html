import { appendFileSync } from 'node:fs';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { merge } from '../../api/convert.js';
import { Report } from '../../api/report.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import {
  type ApiRun,
  envVar,
  type Fetch,
  fetchJobs,
  getJson,
  messageOf,
  say,
  warning,
} from './github-api.js';
import { runKey } from './ids.js';
import { jobLogRecordsRequest } from './job-logs.js';
import { ciMetricsRequest } from './metrics.js';
import { approximateJobs, jobIdFor, parseJobContext } from './publish.js';
import { fetchJobLog, mergeSkippingBad } from './publish-io.js';
import { summaryTable } from './summary.js';
import { ciResource, jobResource, workflowTraceRequest } from './workflow-trace.js';

export type ReportOptions = {
  runId: number;
  repository: string;
  artifacts: string;
  out: string;
  config?: string;
  token?: string;
};

const LOG_CONCURRENCY = 4;
const API_TIMEOUT_MS = 15_000;

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const worker = async (): Promise<void> => {
    for (let i = index++; i < items.length; i = index++) results[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

type Artifact = { report: string; context: ReturnType<typeof parseJobContext> };

async function discoverArtifacts(dir: string): Promise<Artifact[]> {
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith('otel-html-'))
    .map((d) => d.name)
    .sort();
  const found: Artifact[] = [];
  for (const name of names) {
    const report = join(dir, name, 'report');
    if (!(await exists(join(report, 'data', 'manifest.js')))) continue;
    const text = await readFile(join(dir, name, 'context.json'), 'utf8').catch(() => undefined);
    found.push({ report, context: parseJobContext(text) });
  }
  return found;
}

/**
 * Publisher: after the `ci` workflow completes, builds the workflow-trace report from the Actions API, merges it with
 * every job's report artifact and prints a per-job summary. Reads only public run, job, step and log fields. Throws
 * when the run itself cannot be read or merged.
 */
export async function runReport(
  opts: ReportOptions,
  io: CliIo,
  deps: WriterDeps,
  fetchFn: Fetch = fetch,
): Promise<void> {
  const warn = (message: string): void => warning(io, 'report', message);
  const env = (name: string): string | undefined => envVar(io, name);
  const API = env('GITHUB_API_URL') ?? 'https://api.github.com';
  const token = opts.token ?? env('GITHUB_TOKEN');
  const config = opts.config === undefined ? {} : { config: opts.config };

  const run = (
    await getJson<ApiRun>(
      `${API}/repos/${opts.repository}/actions/runs/${opts.runId}`,
      token,
      API_TIMEOUT_MS,
      fetchFn,
    )
  ).body;
  const jobs = await fetchJobs(
    { apiUrl: API, repository: opts.repository, runId: run.id, runAttempt: run.run_attempt },
    token,
    API_TIMEOUT_MS,
    fetchFn,
  );
  const artifacts = await discoverArtifacts(opts.artifacts).catch((e: unknown) => {
    warn(`cannot read ${opts.artifacts}: ${messageOf(e)}`);
    return [] as Artifact[];
  });
  const approximate = approximateJobs(
    jobs,
    artifacts.map((a) => a.context),
  );
  const key = runKey({ repository: run.repository.full_name, runId: run.id, runAttempt: run.run_attempt });
  const resource = ciResource(run);

  const logs = await mapLimited(jobs, LOG_CONCURRENCY, (job) =>
    fetchJobLog({ fetch: fetchFn, apiUrl: API, repository: opts.repository, job, token, warn }),
  );

  const scratch = await mkdtemp(join(tmpdir(), 'otel-html-ci-'));
  try {
    const traceDir = join(scratch, 'workflow-trace');
    const trace = await Report.create(
      {
        out: traceDir,
        title: `${run.name} #${run.id}`,
        replace: true,
        ...config,
      },
      deps,
    );
    await trace.addSpans(workflowTraceRequest(key, run, jobs, approximate));
    for (const [i, job] of jobs.entries()) {
      const text = logs[i];
      if (text === undefined) continue;
      try {
        // Approximate jobs share `name:<job name>` with any same-named approximate job: an inherent limit of the fallback.
        await trace.addLogs(
          jobLogRecordsRequest({
            key,
            jobId: jobIdFor(job, approximate),
            job,
            text,
            resource: jobResource(run, job),
          }),
        );
      } catch (e) {
        warn(`logs of job ${job.name} dropped: ${messageOf(e)}`);
      }
    }
    await trace.addMetrics(ciMetricsRequest(run, jobs, resource));
    await trace.close();

    const { summary, inputs } = await mergeSkippingBad({
      merge: (dirs, out, probe) =>
        merge({ inputs: dirs, out, replace: true, ...(probe ? {} : config) }, deps),
      required: [traceDir],
      optional: artifacts.map((a) => a.report),
      out: opts.out,
      probeOut: (n) => join(scratch, `probe-${n}`),
      warn,
    });
    say(
      io,
      `merged ${inputs.length} reports into ${summary.out}: ${summary.totals.spans} spans, ${summary.totals.logs} logs, ${summary.totals.metrics} metrics`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const reportUrl = env('OTEL_HTML_REPORT_URL') ?? null;
  const table = summaryTable(run, jobs, reportUrl);
  say(io, table);
  const stepSummary = env('GITHUB_STEP_SUMMARY');
  if (stepSummary) {
    try {
      appendFileSync(stepSummary, `${table}\n`);
    } catch (e) {
      warn(`cannot write the step summary: ${messageOf(e)}`);
    }
  }
}
