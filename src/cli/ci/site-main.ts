import { appendFileSync, existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import {
  type ApiRun,
  envVar,
  type Fetch,
  fetchPullsForSha,
  getJson,
  messageOf,
  say,
  warning,
} from './github-api.js';
import { mergeSkippingBad, mergeWithConfig } from './publish-io.js';
import {
  applyRetention,
  channelFor,
  placeRun,
  removeChannel,
  renderRedirect,
  reportUrl,
  rollingInputs,
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
  /** The dashboard config file for the rolling report. */
  config?: string;
};
export type CleanupOptions = { site: string; pr: number; repository: string };

const API_TIMEOUT_MS = 15_000;

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

const RUNS = 'runs';

/**
 * Rebuilds `<site>/<key>/` as the merge of the channel's retained runs, oldest first. The runs live inside that
 * folder (`runs/<id>/`), so the merge goes to a scratch folder and every entry of the channel folder except `runs`
 * is replaced by the merged output's. A merge that fails with no bad input to blame is a warning and the redirect
 * stub is written instead; the per-run report stays published.
 */
async function rebuildRolling(
  site: string,
  key: string,
  index: SiteIndex,
  config: string | undefined,
  deps: WriterDeps,
  io: CliIo,
): Promise<void> {
  const channel = index.channels[key];
  if (channel === undefined) return;
  const scratch = await mkdtemp(join(tmpdir(), 'otel-html-site-'));
  try {
    const merged = join(scratch, 'rolling');
    await mergeSkippingBad({
      merge: mergeWithConfig(deps, config),
      required: [],
      optional: rollingInputs(channel).map((p) => join(site, p)),
      out: merged,
      probeOut: (n) => join(scratch, `probe-${n}`),
      warn: (m) => warning(io, 'report', m),
    });
    const dir = join(site, key);
    await mkdir(dir, { recursive: true });
    for (const name of await readdir(dir)) {
      if (name !== RUNS) await rm(join(dir, name), { recursive: true, force: true });
    }
    for (const name of await readdir(merged)) {
      await cp(join(merged, name), join(dir, name), { recursive: true });
    }
  } catch (e) {
    warning(io, 'site', `rolling report of ${key} not rebuilt: ${messageOf(e)}`);
    await writeStub(site, key, index);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Places a finished run's report on the site: resolves its channel, copies the report to the run's folder, applies
 * retention and rewrites the index, landing page and the channel's page (the rolling report for a workflow
 * channel, a redirect stub to the latest run for a pull request). A run with no channel is announced and skipped.
 * Throws when the run cannot be read from the API.
 */
export async function runSite(
  opts: SiteOptions,
  io: CliIo,
  deps: WriterDeps,
  fetchFn: Fetch = fetch,
): Promise<void> {
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
  if (placed.channel.kind === 'workflow') {
    await rebuildRolling(opts.site, placed.key, index, opts.config, deps, io);
  } else {
    await writeStub(opts.site, placed.key, index);
  }
  await writeSite(opts.site, index, opts.repository);
  setOutputs(io, {
    'report-url': reportUrl(opts.baseUrl.replace(/\/+$/, ''), reportPath),
    channel: placed.key,
    published: 'true',
  });
}

/**
 * Removes pull request `pr`'s channel and folder from the site and writes `cleaned=true` to $GITHUB_OUTPUT. A pull
 * request the site never had (no channel and no folder) changes nothing and writes `cleaned=false`, so the caller
 * pushes and deploys nothing.
 */
export async function runCleanup(opts: CleanupOptions, io: CliIo): Promise<void> {
  const key = `pr/${opts.pr}`;
  const current = await readSiteIndex(opts.site);
  if (current.channels[key] === undefined && !existsSync(join(opts.site, key))) {
    say(io, `${key} is not on the site; nothing to remove`);
    setOutputs(io, { cleaned: 'false' });
    return;
  }
  const { index, remove } = removeChannel(current, key);
  await removePaths(opts.site, [...remove, key]);
  await writeSite(opts.site, index, opts.repository);
  say(io, `removed ${key} from the site`);
  setOutputs(io, { cleaned: 'true' });
}
