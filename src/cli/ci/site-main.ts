import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliIo } from '../io.js';
import { type ApiRun, type Fetch, fetchPullsForSha, getJson, say } from './github-api.js';
import {
  applyRetention,
  channelFor,
  placeRun,
  removeChannel,
  renderRedirect,
  reportUrl,
  type SiteIndex,
  type SiteRun,
} from './site.js';
import { copyReport, readSiteIndex, removePaths, writeSite } from './site-io.js';

export type SiteOptions = {
  site: string;
  report: string;
  runId: number;
  repository: string;
  baseUrl: string;
  retention: number;
  prRetention: number;
};
export type CleanupOptions = { site: string; pr: number; repository: string };

const API_TIMEOUT_MS = 15_000;

const envVar = (io: CliIo, name: string): string | undefined => io.env[name] || undefined;

function setOutputs(io: CliIo, values: Record<string, string>): void {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  for (const line of lines) say(io, line);
  const file = envVar(io, 'GITHUB_OUTPUT');
  if (file) appendFileSync(file, `${lines.join('\n')}\n`);
}

/** `<site>/<key>/index.html`: a stub forwarding to the channel's newest run. */
async function writeStub(site: string, key: string, index: SiteIndex): Promise<void> {
  const latest = index.channels[key]?.runs[0];
  if (latest === undefined) return;
  await mkdir(join(site, key), { recursive: true });
  await writeFile(join(site, key, 'index.html'), renderRedirect(`runs/${latest.runId}/`));
}

/**
 * Places a finished run's report on the site: resolves its channel, copies the report to the run's folder, applies
 * retention and rewrites the index, landing page and channel stub. A run with no channel is announced and skipped.
 * Throws when the run cannot be read from the API.
 */
export async function runSite(opts: SiteOptions, io: CliIo, fetchFn: Fetch = fetch): Promise<void> {
  const api = envVar(io, 'GITHUB_API_URL') ?? 'https://api.github.com';
  const token = envVar(io, 'GITHUB_TOKEN');
  const get = async <T>(path: string): Promise<T> =>
    (await getJson<T>(`${api}/repos/${opts.repository}${path}`, token, API_TIMEOUT_MS, fetchFn)).body;

  const run = await get<ApiRun>(`/actions/runs/${opts.runId}`);
  const { default_branch: defaultBranch } = await get<{ default_branch: string }>('');
  const pulls = await fetchPullsForSha(
    { apiUrl: api, repository: opts.repository, sha: run.head_sha },
    token,
    API_TIMEOUT_MS,
    fetchFn,
  );
  const placed = channelFor(run, pulls, defaultBranch);
  if (placed === undefined) {
    say(
      io,
      `::notice::otel-html site: run ${run.id} (${run.head_branch ?? 'unknown branch'}) has no open pull request and is not on the default branch; not published`,
    );
    setOutputs(io, { published: 'false' });
    return;
  }

  const reportPath = `${placed.key}/runs/${run.id}`;
  const siteRun: SiteRun = {
    runId: run.id,
    attempt: run.run_attempt,
    conclusion: run.conclusion ?? 'unknown',
    headSha: run.head_sha,
    headBranch: run.head_branch ?? '',
    completedAt: run.updated_at,
    runUrl: run.html_url,
    reportPath,
  };
  const current = await readSiteIndex(opts.site);
  const { index, remove } = applyRetention(placeRun(current, placed.key, placed.channel, siteRun), {
    workflow: opts.retention,
    pr: opts.prRetention,
  });
  await copyReport(opts.report, join(opts.site, reportPath));
  await removePaths(
    opts.site,
    remove.filter((p) => p !== reportPath),
  );
  await writeStub(opts.site, placed.key, index);
  await writeSite(opts.site, index, opts.repository);
  setOutputs(io, {
    'report-url': reportUrl(opts.baseUrl.replace(/\/+$/, ''), reportPath),
    channel: placed.key,
    published: 'true',
  });
}

/** Removes pull request `pr`'s channel and folder from the site. A pull request the site never had changes nothing. */
export async function runCleanup(opts: CleanupOptions, io: CliIo): Promise<void> {
  const key = `pr/${opts.pr}`;
  const { index, remove } = removeChannel(await readSiteIndex(opts.site), key);
  await removePaths(opts.site, [...remove, key]);
  await writeSite(opts.site, index, opts.repository);
  say(io, `removed ${key} from the site`);
}
