import { type JobId, jobTraceparent, runKey } from './ids.js';

/** The subset of the Actions jobs API that the CI scripts read. */
export type ApiStep = {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};

export type ApiJob = {
  id: number;
  name: string;
  status: string;
  runner_name: string | null;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  html_url: string | null;
  steps: ApiStep[];
};

export type ResolvedJob = { jobId: JobId; approximate: boolean };

/**
 * Finds the job this script is running in: the one in-progress job on this runner. Zero or several matches cannot be
 * told apart, so fall back to the name hash (`name:<hint>`), which the publisher derives the same way.
 */
export function resolveJob(jobs: ApiJob[], runnerName: string, jobNameHint: string): ResolvedJob {
  const matches = jobs.filter((j) => j.status === 'in_progress' && j.runner_name === runnerName);
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { jobId: only.id, approximate: false };
  return { jobId: `name:${jobNameHint}`, approximate: true };
}

export type ContextInputs = {
  repository: string;
  runId: number;
  runAttempt: number;
  workflow: string;
  runUrl: string;
  ref: string;
  sha: string;
  serverUrl: string;
  jobName: string;
  jobId: JobId;
  existingResourceAttributes?: string;
};

const encodeValue = (v: string): string =>
  v.replace(/[%,=]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `TRACEPARENT`, `OTEL_RESOURCE_ATTRIBUTES` (existing pairs first, ours appended) and `OTEL_SERVICE_NAME`. */
export type ContextEnv = { TRACEPARENT: string; OTEL_RESOURCE_ATTRIBUTES: string; OTEL_SERVICE_NAME: string };

export function contextEnv(i: ContextInputs): ContextEnv {
  const key = runKey(i);
  const ours: [string, string][] = [
    ['cicd.pipeline.name', i.workflow],
    ['cicd.pipeline.run.id', String(i.runId)],
    ['cicd.pipeline.run.url.full', i.runUrl],
    ['cicd.pipeline.task.name', i.jobName],
    ['vcs.ref.head.name', i.ref],
    ['vcs.ref.head.revision', i.sha],
    ['vcs.repository.url.full', `${i.serverUrl}/${i.repository}`],
  ];
  const pairs = ours.map(([k, v]) => `${k}=${encodeValue(v)}`);
  const ourKeys = new Set(ours.map(([k]) => k));
  const existing = (i.existingResourceAttributes ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '' && !ourKeys.has(p.split('=')[0]?.trim() ?? ''))
    .join(',');
  return {
    TRACEPARENT: jobTraceparent(key, i.jobId),
    OTEL_RESOURCE_ATTRIBUTES: [...(existing === '' ? [] : [existing]), ...pairs].join(','),
    OTEL_SERVICE_NAME: `${i.workflow}/${i.jobName}`,
  };
}

/** The raw facts the entry point reads from the environment, before the jobs lookup. */
export type RawInputs = Omit<ContextInputs, 'jobName' | 'jobId'> & {
  runnerName: string;
  jobNameHint: string;
  token: string | undefined;
  apiUrl: string;
  envFile: string;
};

type Env = Record<string, string | undefined>;

/** Reads the `GITHUB_*` environment; throws naming the first variable that is missing or malformed. */
export function readInputs(env: Env): RawInputs {
  const opt = (name: string): string | undefined => (env[name] === '' ? undefined : env[name]);
  const need = (name: string): string => {
    const v = env[name];
    if (v === undefined || v === '') throw new Error(`${name} is not set`);
    return v;
  };
  const num = (name: string): number => {
    const n = Number(need(name));
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} is not a number: ${env[name]}`);
    return n;
  };
  const repository = need('GITHUB_REPOSITORY');
  const runId = num('GITHUB_RUN_ID');
  const serverUrl = need('GITHUB_SERVER_URL');
  const hint = opt('OTEL_HTML_JOB_NAME');
  const existing = opt('OTEL_RESOURCE_ATTRIBUTES');
  return {
    repository,
    runId,
    runAttempt: num('GITHUB_RUN_ATTEMPT'),
    workflow: need('GITHUB_WORKFLOW'),
    runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
    ref: need('GITHUB_REF_NAME'),
    sha: need('GITHUB_SHA'),
    serverUrl,
    runnerName: need('RUNNER_NAME'),
    jobNameHint: hint ?? need('GITHUB_JOB'),
    token: opt('GITHUB_TOKEN'),
    apiUrl: opt('GITHUB_API_URL') ?? 'https://api.github.com',
    envFile: need('GITHUB_ENV'),
    ...(existing === undefined ? {} : { existingResourceAttributes: existing }),
  };
}

/** The `rel="next"` target of an RFC 8288 `Link` header, if any. */
export function parseNextLink(header: string | null): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(',')) {
    const m = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
    if (m?.[1] !== undefined && /;?\s*rel="?next"?/.test(`;${m[2]}`)) return m[1];
  }
  return undefined;
}

export const jobsUrl = (i: Pick<RawInputs, 'apiUrl' | 'repository' | 'runId' | 'runAttempt'>): string =>
  `${i.apiUrl}/repos/${i.repository}/actions/runs/${i.runId}/attempts/${i.runAttempt}/jobs?per_page=100`;

/** `KEY=value` lines for `$GITHUB_ENV`. A newline would start a second assignment, so it is flattened to a space. */
export function envFileText(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v.replace(/\r?\n|\r/g, ' ')}\n`)
    .join('');
}

/** What the publisher reads to pick the same job id. */
export const contextJson = (r: ResolvedJob): string =>
  `${JSON.stringify({ jobId: r.jobId, approximate: r.approximate })}\n`;
