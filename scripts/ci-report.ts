import { appendFileSync } from 'node:fs';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { merge } from '../src/api/convert.js';
import { Report } from '../src/api/report.js';
import { type ApiJob, parseNextLink } from './ci/context.js';
import { runKey } from './ci/ids.js';
import { jobLogRecordsRequest } from './ci/job-logs.js';
import { ciMetricsRequest } from './ci/metrics.js';
import { approximateJobs, jobIdFor, parseJobContext, parsePublishArgs } from './ci/publish.js';
import { summaryTable } from './ci/summary.js';
import { type ApiRun, ciResource, workflowTraceRequest } from './ci/workflow-trace.js';

/**
 * Publisher: after the `ci` workflow completes, builds the workflow-trace report from the Actions API, merges it with
 * every job's report artifact and prints a per-job summary. Reads only public run, job, step and log fields.
 *
 *   bun scripts/ci-report.ts --run-id <n> --repository <owner/repo> --artifacts <dir> --out <dir> [--config <file>]
 */
const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};
const warn = (message: string): void => say(`::warning::otel-html report: ${message.replace(/\r?\n/g, ' ')}`);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const envVar = (name: string): string | undefined => process.env[name] || undefined;

const API = envVar('GITHUB_API_URL') ?? 'https://api.github.com';
const LOG_CONCURRENCY = 4;

const headers = (token: string | undefined): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
});

async function getJson<T>(url: string, token: string | undefined): Promise<{ body: T; link: string | null }> {
  const res = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return { body: (await res.json()) as T, link: res.headers.get('link') };
}

async function fetchJobs(run: ApiRun, repository: string, token: string | undefined): Promise<ApiJob[]> {
  const jobs: ApiJob[] = [];
  let next: string | undefined =
    `${API}/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`;
  while (next !== undefined) {
    const page: { body: { jobs?: ApiJob[] }; link: string | null } = await getJson(next, token);
    jobs.push(...(page.body.jobs ?? []));
    next = parseNextLink(page.link);
  }
  return jobs;
}

/** The job's log text, or undefined (with a warning) when it cannot be had. The signed URL never sees the token. */
async function fetchLog(
  repository: string,
  job: ApiJob,
  token: string | undefined,
): Promise<string | undefined> {
  try {
    let res = await fetch(`${API}/repos/${repository}/actions/jobs/${job.id}/logs`, {
      headers: headers(token),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location !== null) {
      res = await fetch(location, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    }
    if (!res.ok) {
      warn(`no log for job ${job.name}: answered ${res.status}`);
      return undefined;
    }
    return await res.text();
  } catch (e) {
    warn(`no log for job ${job.name}: ${messageOf(e)}`);
    return undefined;
  }
}

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

async function main(): Promise<number> {
  const opts = parsePublishArgs(process.argv.slice(2));
  const token = envVar('GITHUB_TOKEN');
  const config = opts.config === undefined ? {} : { config: opts.config };

  const run = (await getJson<ApiRun>(`${API}/repos/${opts.repository}/actions/runs/${opts.runId}`, token))
    .body;
  const jobs = await fetchJobs(run, opts.repository, token);
  const artifacts = await discoverArtifacts(opts.artifacts).catch((e: unknown) => {
    warn(`cannot read ${opts.artifacts}: ${messageOf(e)}`);
    return [] as Artifact[];
  });
  const approximate = approximateJobs(
    jobs,
    artifacts.map((a) => a.context),
  );
  const key = runKey({ repository: opts.repository, runId: run.id, runAttempt: run.run_attempt });
  const resource = ciResource(run);

  const logs = await mapLimited(jobs, LOG_CONCURRENCY, (job) => fetchLog(opts.repository, job, token));

  const scratch = await mkdtemp(join(tmpdir(), 'otel-html-ci-'));
  try {
    const traceDir = join(scratch, 'workflow-trace');
    const trace = await Report.create({
      out: traceDir,
      title: `${run.name} #${run.id}`,
      replace: true,
      ...config,
    });
    await trace.addSpans(workflowTraceRequest(run, jobs, approximate));
    for (const [i, job] of jobs.entries()) {
      const text = logs[i];
      if (text === undefined) continue;
      await trace.addLogs(
        jobLogRecordsRequest({ key, jobId: jobIdFor(job, approximate), job, text, resource }),
      );
    }
    await trace.addMetrics(ciMetricsRequest(run, jobs, resource));
    await trace.close();

    let inputs = [traceDir, ...artifacts.map((a) => a.report)];
    let summary: Awaited<ReturnType<typeof merge>>;
    try {
      summary = await merge({ inputs, out: opts.out, replace: true, ...config });
    } catch (first) {
      // One unreadable report (say, a newer format version) must not sink the rest: find it, skip it, merge again.
      const bad: string[] = [];
      for (const [i, dir] of artifacts.map((a) => a.report).entries()) {
        try {
          await merge({ inputs: [dir], out: join(scratch, `probe-${i}`), replace: true });
        } catch (e) {
          warn(`skipping ${dir}: ${messageOf(e)}`);
          bad.push(dir);
        }
      }
      if (bad.length === 0) throw first;
      inputs = inputs.filter((d) => !bad.includes(d));
      summary = await merge({ inputs, out: opts.out, replace: true, ...config });
    }
    say(
      `merged ${inputs.length} reports into ${summary.out}: ${summary.totals.spans} spans, ${summary.totals.logs} logs, ${summary.totals.metrics} metrics`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const reportUrl = envVar('OTEL_HTML_REPORT_URL') ?? null;
  const table = summaryTable(run, jobs, reportUrl);
  say(table);
  const stepSummary = envVar('GITHUB_STEP_SUMMARY');
  if (stepSummary) appendFileSync(stepSummary, `${table}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    say(`::error::otel-html report: ${messageOf(e)}`);
    process.exitCode = 1;
  },
);
