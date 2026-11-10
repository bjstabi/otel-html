import { createReportWith } from '../../api/report.js';
import type { PartitionFile } from '../../format/manifest.js';
import type { Table } from '../../format/parquet/columns.js';
import { TABLES } from '../../format/parquet/columns.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { WriterDeps } from '../../writer/session.js';
import type { ApiJob, ApiRun, Fetch } from './github-api.js';
import { fetchJobs, getJson } from './github-api.js';
import type { JobId } from './ids.js';
import { runKey } from './ids.js';
import type { Ledger } from './ledger.js';
import type { JobContext } from './publish.js';
import { approximateJobIds } from './publish.js';
import { readRunManifest } from './run-report.js';
import type { UpdateJson, UpdatePartition } from './update.js';
import { jobSourceKey, UPDATE_FILE } from './update.js';
import { jobTraceRequest } from './workflow-trace.js';

const API_TIMEOUT_MS = 15_000;

export interface PushUpdateInput {
  deps: Pick<WriterDeps, 'fs'>;
  /** The job's report folder (`.otel-html/report`). */
  report: string;
  /** What the pusher has already uploaded (D60). */
  ledger: Ledger;
  /** The update folder to write (`<updates>/<name>`); replaced when present. */
  out: string;
  runId: number;
  runAttempt: number;
  jobId: JobId;
  jobName: string;
  sequence: number;
  createdAt: string;
  /** A one-partition report folder holding this job's provisional CI spans (D61). */
  ciReport?: string;
}

const bad = (path: string, expected: string): OtelHtmlError =>
  new OtelHtmlError('invalid-report', { path, expected });

async function copyFile(
  fs: Pick<WriterDeps['fs'], 'readBytes' | 'writeBytes' | 'mkdirp'>,
  from: string,
  to: string,
): Promise<void> {
  await fs.mkdirp(to.slice(0, to.lastIndexOf('/')));
  await fs.writeBytes(to, await fs.readBytes(from));
}

/** The entry's files, renumbered to `<prefix>/<table>.parquet` (update-relative), copied from `report` when `copy` is set. */
async function listFiles(
  fs: PushUpdateInput['deps']['fs'],
  report: string,
  files: Partial<Record<Table, PartitionFile>>,
  prefix: string,
  copyTo: string | undefined,
): Promise<Partial<Record<Table, PartitionFile>>> {
  const listed: Partial<Record<Table, PartitionFile>> = {};
  for (const t of TABLES) {
    const f = files[t];
    if (f === undefined) continue;
    const path = `${prefix}/${t}.parquet`;
    listed[t] = { ...f, path };
    if (copyTo !== undefined) await copyFile(fs, `${report}/${f.path}`, `${copyTo}/${path}`);
  }
  return listed;
}

/**
 * Builds a `push` update folder (D60, D61) from the job's report: every manifest partition is listed as
 * `job:<job key>#<source>`, carried unless the ledger says its source was already shipped (then its files are not
 * copied). Returns `undefined` when the report has no partitions yet; throws when the report cannot be read or a
 * partition file is gone (a compaction ran between the manifest read and the copy), so the caller retries.
 */
export async function buildPushUpdate(
  i: PushUpdateInput,
): Promise<{ update: UpdateJson; sources: string[] } | undefined> {
  const { fs } = i.deps;
  const manifest = await readRunManifest(fs, i.report);
  if (manifest === null || manifest.partitions.length === 0) return undefined;
  const key = jobSourceKey(i.jobId, i.runAttempt);
  const shipped = new Set(i.ledger.shipped);
  await fs.removeDir(i.out);
  await fs.mkdirp(i.out);

  const partitions: UpdatePartition[] = [];
  for (const [index, entry] of manifest.partitions.entries()) {
    const carried = !shipped.has(entry.source);
    partitions.push({
      source: `job:${key}#${entry.source}`,
      files: await listFiles(fs, i.report, entry.files, `partitions/${index}`, carried ? i.out : undefined),
      carried,
    });
  }

  let ci: UpdatePartition | undefined;
  if (i.ciReport !== undefined) {
    const ciManifest = await readRunManifest(fs, i.ciReport);
    const [only] = ciManifest?.partitions ?? [];
    if (ciManifest?.partitions.length !== 1 || only === undefined)
      throw bad(i.ciReport, 'a CI spans report of one partition');
    ci = {
      source: `ci:${key}`,
      files: await listFiles(fs, i.ciReport, only.files, 'ci', i.out),
      carried: true,
    };
  }

  const update: UpdateJson = {
    version: 1,
    kind: 'push',
    runId: i.runId,
    runAttempt: i.runAttempt,
    createdAt: i.createdAt,
    jobId: i.jobId,
    jobName: i.jobName,
    sequence: i.sequence,
    partitions,
    ...(ci === undefined ? {} : { ci }),
  };
  await fs.writeTextAtomic(`${i.out}/${UPDATE_FILE}`, JSON.stringify(update));
  return { update, sources: manifest.partitions.map((p) => p.source) };
}

/** The API job this context runs as: its numeric id, or the one `approximateJobIds` maps to the context's id. */
function jobOf(jobs: ApiJob[], ctx: JobContext): ApiJob | undefined {
  if (!ctx.approximate) return jobs.find((j) => j.id === ctx.jobId);
  const ids = approximateJobIds(jobs, [ctx]);
  return jobs.find((j) => ids.get(j.id) === ctx.jobId);
}

/**
 * D61: the job's display name from the jobs API, and a real report (`site` format, one partition) of its provisional
 * CI spans written to `scratch`. `report` is absent, with `why`, when the API cannot say (no token, a failed call, the
 * job not listed); the caller falls back to the hint and carries no `ci` partition.
 */
export async function ciSpansFromApi(i: {
  deps: WriterDeps;
  fetchFn: Fetch;
  apiUrl: string;
  token: string | undefined;
  repository: string;
  runId: number;
  runAttempt: number;
  ctx: JobContext;
  config: string | undefined;
  scratch: string;
  nowMs: number;
}): Promise<{ jobName?: string; report?: string; why?: string }> {
  if (i.token === undefined) return { why: 'GITHUB_TOKEN is not set' };
  const run = (
    await getJson<ApiRun>(
      `${i.apiUrl}/repos/${i.repository}/actions/runs/${i.runId}`,
      i.token,
      API_TIMEOUT_MS,
      i.fetchFn,
    )
  ).body;
  const jobs = await fetchJobs(
    { apiUrl: i.apiUrl, repository: i.repository, runId: i.runId, runAttempt: i.runAttempt },
    i.token,
    API_TIMEOUT_MS,
    i.fetchFn,
  );
  const job = jobOf(jobs, i.ctx);
  if (job === undefined) return { why: `job ${String(i.ctx.jobId)} is not in the run's jobs` };
  const key = runKey({ repository: run.repository.full_name, runId: run.id, runAttempt: run.run_attempt });
  const report = await createReportWith(
    {
      out: i.scratch,
      title: `${run.name} #${run.id}`,
      replace: true,
      format: 'site',
      ...(i.config === undefined ? {} : { config: i.config }),
    },
    i.deps,
  );
  await report.addSpans(jobTraceRequest(key, run, job, i.nowMs, approximateJobIds(jobs, [i.ctx])));
  await report.close();
  return { jobName: job.name, report: i.scratch };
}
