import type { CliIo } from '../io.js';

/** The GitHub Actions API as the CI scripts use it: the fields they read, paging, and the workflow-command output. */

/** The subset of the Actions run API that the CI scripts read. */
export type ApiRun = {
  id: number;
  run_attempt: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
  repository: { full_name: string; html_url: string };
  head_repository: { full_name: string } | null;
};

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

/** The environment variable `name`, or undefined when unset or empty. */
export const envVar = (io: Pick<CliIo, 'env'>, name: string): string | undefined => io.env[name] || undefined;

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const say = (io: Pick<CliIo, 'stdout'>, message: string): void => {
  io.stdout(`${message}\n`);
};

/** A `::warning::` workflow command from `scope` (`report`, `context`); a newline would end the command. */
export const warning = (io: Pick<CliIo, 'stdout'>, scope: string, message: string): void =>
  say(io, `::warning::otel-html ${scope}: ${message.replace(/\r?\n/g, ' ')}`);

export const apiHeaders = (token: string | undefined): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
});

/** The `rel="next"` target of an RFC 8288 `Link` header, if any. */
export function parseNextLink(header: string | null): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(',')) {
    const m = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
    if (m?.[1] !== undefined && /;?\s*rel="?next"?/.test(`;${m[2]}`)) return m[1];
  }
  return undefined;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** GETs `url` and decodes the JSON body; throws naming the URL on a non-2xx answer or after `timeoutMs`. */
export async function getJson<T>(
  url: string,
  token: string | undefined,
  timeoutMs: number,
  fetchFn: Fetch = fetch,
): Promise<{ body: T; link: string | null }> {
  const res = await fetchFn(url, { headers: apiHeaders(token), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return { body: (await res.json()) as T, link: res.headers.get('link') };
}

/** Follows `Link: rel="next"` from `first`, collecting `pick(body)` of every page. */
export async function fetchPaged<B, T>(
  first: string,
  token: string | undefined,
  timeoutMs: number,
  pick: (body: B) => T[],
  fetchFn: Fetch = fetch,
): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = first;
  while (next !== undefined) {
    const page: { body: B; link: string | null } = await getJson<B>(next, token, timeoutMs, fetchFn);
    items.push(...pick(page.body));
    next = parseNextLink(page.link);
  }
  return items;
}

export const jobsUrl = (i: {
  apiUrl: string;
  repository: string;
  runId: number;
  runAttempt: number;
}): string =>
  `${i.apiUrl}/repos/${i.repository}/actions/runs/${i.runId}/attempts/${i.runAttempt}/jobs?per_page=100`;

/**
 * The name of the check run `ci link` creates. Created with the workflow token, it joins the triggering run's check
 * suite, so the jobs API lists it as a job of that run.
 */
export const CHECK_RUN_NAME = 'otel-html report';

/** Every job of one run attempt, without the `ci link` check run (which is not a job of the workflow). */
export const fetchJobs = async (
  i: { apiUrl: string; repository: string; runId: number; runAttempt: number },
  token: string | undefined,
  timeoutMs: number,
  fetchFn: Fetch = fetch,
): Promise<ApiJob[]> =>
  (
    await fetchPaged<{ jobs?: ApiJob[] }, ApiJob>(jobsUrl(i), token, timeoutMs, (b) => b.jobs ?? [], fetchFn)
  ).filter((j) => j.name !== CHECK_RUN_NAME);

/** Sends `body` as JSON with `method` and decodes the JSON answer; throws naming the URL on a non-2xx answer or after `timeoutMs`. */
export async function sendJson<T>(
  method: 'POST' | 'PATCH',
  url: string,
  body: unknown,
  token: string | undefined,
  timeoutMs: number,
  fetchFn: Fetch = fetch,
): Promise<T> {
  const res = await fetchFn(url, {
    method,
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

/** The subset of the pull request API that the publisher reads. */
export type ApiPull = {
  number: number;
  title: string;
  state: string;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
};

/** Every pull request that contains commit `sha`. */
export const fetchPullsForSha = (
  i: { apiUrl: string; repository: string; sha: string },
  token: string | undefined,
  timeoutMs: number,
  fetchFn: Fetch = fetch,
): Promise<ApiPull[]> =>
  fetchPaged<ApiPull[], ApiPull>(
    `${i.apiUrl}/repos/${i.repository}/commits/${i.sha}/pulls?per_page=100`,
    token,
    timeoutMs,
    (b) => b,
    fetchFn,
  );
