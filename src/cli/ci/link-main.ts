import { appendFileSync } from 'node:fs';
import type { CliIo } from '../io.js';
import {
  type ApiJob,
  type ApiPull,
  type ApiRun,
  envVar,
  type Fetch,
  fetchJobs,
  fetchPaged,
  fetchPullsForSha,
  getJson,
  messageOf,
  sendJson,
  warning,
} from './github-api.js';
import {
  type ApiComment,
  channelPage,
  channelPageOf,
  checkRunPayload,
  commentBody,
  findStickyComment,
  previousRun,
  previousRunOf,
} from './link.js';
import { channelFor, parseSiteIndex, pullsToLink, slug } from './site.js';
import { readSiteIndex } from './site-io.js';

export type LinkOptions = {
  runId: number;
  repository: string;
  url: string;
  /** The site folder (`--site`), until PR 3 removes it; exactly one of `site` and `indexUrl` is set. */
  site?: string;
  /** The live site's `index.json` URL (`--index-url`, D57). */
  indexUrl?: string;
  comment: boolean;
  check: boolean;
};

const API_TIMEOUT_MS = 15_000;

/**
 * Links a published report from where people look: a sticky comment on each open pull request of the run's head
 * commit, a neutral check run on the commit, and the job summary. Never throws: every failure is a `::warning::`.
 */
export async function runLink(opts: LinkOptions, io: CliIo, fetchFn: Fetch = fetch): Promise<void> {
  const warn = (message: string): void => warning(io, 'link', message);
  const api = envVar(io, 'GITHUB_API_URL') ?? 'https://api.github.com';
  const token = envVar(io, 'GITHUB_TOKEN');
  const repo = `${api}/repos/${opts.repository}`;

  let run: ApiRun;
  try {
    run = (await getJson<ApiRun>(`${repo}/actions/runs/${opts.runId}`, token, API_TIMEOUT_MS, fetchFn)).body;
  } catch (e) {
    warn(`cannot read run ${opts.runId}: ${messageOf(e)}`);
    return;
  }
  let jobs: ApiJob[] = [];
  try {
    jobs = await fetchJobs(
      { apiUrl: api, repository: opts.repository, runId: run.id, runAttempt: run.run_attempt },
      token,
      API_TIMEOUT_MS,
      fetchFn,
    );
  } catch (e) {
    warn(`cannot read the jobs of run ${opts.runId}, so the table is empty: ${messageOf(e)}`);
  }
  // As `ci site` places it: a default-branch run is the workflow's, so no pull request gets its comment.
  let pulls: ApiPull[] = [];
  let placed: ReturnType<typeof channelFor>;
  if (opts.comment || opts.indexUrl !== undefined) {
    try {
      const { default_branch: defaultBranch } = (
        await getJson<{ default_branch: string }>(repo, token, API_TIMEOUT_MS, fetchFn)
      ).body;
      try {
        const all = await fetchPullsForSha(
          { apiUrl: api, repository: opts.repository, sha: run.head_sha },
          token,
          API_TIMEOUT_MS,
          fetchFn,
        );
        if (opts.comment) pulls = pullsToLink(run, all, defaultBranch);
        placed = channelFor(run, all, defaultBranch);
      } catch (e) {
        warn(`cannot list the pull requests of ${run.head_sha}, so no comment is posted: ${messageOf(e)}`);
      }
    } catch (e) {
      warn(`cannot read the default branch of ${opts.repository}, so no comment is posted: ${messageOf(e)}`);
    }
  }

  let previous: ReturnType<typeof previousRun>;
  let page: ReturnType<typeof channelPage>;
  if (opts.indexUrl !== undefined) {
    // D57: the channel comes from the API, so a run the live index does not list yet still gets both lines.
    const baseUrl = opts.indexUrl.replace(/\/index\.json$/, '').replace(/\/+$/, '');
    if (placed !== undefined) page = channelPageOf(placed.key, placed.channel, baseUrl);
    try {
      const res = await fetchFn(opts.indexUrl, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${opts.indexUrl} answered ${res.status}`);
      const index = parseSiteIndex(await res.text(), warn);
      if (placed !== undefined) previous = previousRunOf(index, placed.key, run.id, baseUrl, slug(run.name));
    } catch (e) {
      warn(`cannot read the site index, so no previous run is linked: ${messageOf(e)}`);
    }
  } else if (opts.site !== undefined) {
    try {
      const index = await readSiteIndex(opts.site, warn);
      previous = previousRun(index, run.id, opts.url);
      page = channelPage(index, run.id, opts.url);
    } catch (e) {
      warn(`cannot read the site index, so no previous run or channel page is linked: ${messageOf(e)}`);
    }
  }
  const body = commentBody(run, jobs, opts.url, previous, page);

  const summaryFile = envVar(io, 'GITHUB_STEP_SUMMARY');
  if (summaryFile) {
    try {
      appendFileSync(summaryFile, `${body}\n`);
    } catch (e) {
      warn(`cannot write the step summary: ${messageOf(e)}`);
    }
  }

  for (const pull of pulls) {
    const comments = `${repo}/issues/${pull.number}/comments`;
    try {
      const existing = findStickyComment(
        await fetchPaged<ApiComment[], ApiComment>(
          `${comments}?per_page=100`,
          token,
          API_TIMEOUT_MS,
          (b) => b,
          fetchFn,
        ),
        slug(run.name),
      );
      if (existing === undefined) await sendJson('POST', comments, { body }, token, API_TIMEOUT_MS, fetchFn);
      else
        await sendJson(
          'PATCH',
          `${repo}/issues/comments/${existing}`,
          { body },
          token,
          API_TIMEOUT_MS,
          fetchFn,
        );
    } catch (e) {
      warn(`cannot comment on pull request #${pull.number}: ${messageOf(e)}`);
    }
  }

  if (opts.check) {
    try {
      await sendJson(
        'POST',
        `${repo}/check-runs`,
        checkRunPayload(run, opts.url),
        token,
        API_TIMEOUT_MS,
        fetchFn,
      );
    } catch (e) {
      warn(`cannot create the check run: ${messageOf(e)}`);
    }
  }
}
