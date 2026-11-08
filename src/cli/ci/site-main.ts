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
  dropWorkflowChannels,
  placeRun,
  removeChannel,
  renderRedirect,
  reportUrl,
  rollingInputs,
  type SiteIndex,
  type SiteRun,
} from './site.js';
import {
  ensureSharedAssets,
  placeRunReport,
  pruneAssets,
  readSiteIndex,
  removePaths,
  writeBadges,
  writeSite,
} from './site-io.js';

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

/** The `../` steps from a site-relative folder back to the site root. */
const up = (folder: string): string => '../'.repeat(folder.split('/').filter((x) => x !== '').length);

/** Where the rolling report at `<site>/<key>/` (`branch/<slug>`, `pr/<n>`: two folders deep) loads the shared viewer files from. */
const rollingAssetsBase = (key: string, version: string): string => `${up(key)}assets/${version}/`;
/** Where a run report at `<site>/<key>/runs/<id>/` loads them from. */
const runAssetsBase = (reportPath: string, version: string): string => `${up(reportPath)}assets/${version}/`;

const PREVIEW = /^preview-.*\.png$/;

/** Empties `<site>/<key>/` (creating it if absent) except its `runs/` and its `preview-*.png` screenshots. */
async function clearRolling(site: string, key: string): Promise<void> {
  const dir = join(site, key);
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) {
    if (name !== RUNS && !PREVIEW.test(name)) await rm(join(dir, name), { recursive: true, force: true });
  }
}

/**
 * Rebuilds `<site>/<key>/` as the merge of the channel's retained runs, oldest first. The runs live inside that
 * folder (`runs/<id>/`), so the merge goes to a scratch folder and every entry of the channel folder except `runs`
 * is replaced by the merged output's, `preview-*.png` screenshots aside. Returns `built`, or `stub` when the merge
 * failed. A merge that fails with no bad input to blame is a warning and the folder is
 * left with only `runs/` and the redirect stub; the per-run report stays published.
 */
async function rebuildRolling(
  site: string,
  key: string,
  index: SiteIndex,
  config: string | undefined,
  deps: WriterDeps,
  io: CliIo,
): Promise<'built' | 'stub'> {
  const channel = index.channels[key];
  if (channel === undefined) return 'stub';
  const scratch = await mkdtemp(join(tmpdir(), 'otel-html-site-'));
  try {
    const merged = join(scratch, 'rolling');
    await mergeSkippingBad({
      merge: mergeWithConfig(deps, config, {
        format: 'site',
        assetsBase: rollingAssetsBase(key, deps.version),
        compact: true,
      }),
      required: [],
      optional: rollingInputs(channel).map((p) => join(site, p)),
      out: merged,
      probeOut: (n) => join(scratch, `probe-${n}`),
      warn: (m) => warning(io, 'report', m),
    });
    await clearRolling(site, key);
    for (const name of await readdir(merged)) {
      await cp(join(merged, name), join(site, key, name), { recursive: true });
    }
    return 'built';
  } catch (e) {
    warning(io, 'site', `rolling report of ${key} not rebuilt: ${messageOf(e)}`);
    // the stub alone, not beside a stale or half-replaced rolling report
    await clearRolling(site, key);
    await writeStub(site, key, index);
    return 'stub';
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Places a finished run's report on the site: resolves its channel (`branch/<default>` or `pr/<n>`), copies the
 * report to the run's folder, applies retention, drops the older per-workflow channels (`ci/`, `load/`) and rewrites
 * the index, landing page and the channel's rolling report. A run with no channel is announced and skipped. Throws
 * when the run cannot be read from the API.
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
    startedAt: run.run_started_at ?? run.created_at,
    completedAt: run.updated_at,
    runUrl: run.html_url,
    reportPath,
    workflow: run.name,
  };
  const migrated = dropWorkflowChannels(await readSiteIndex(opts.site, (m) => warning(io, 'site', m)));
  const { index, remove } = applyRetention(
    placeRun(migrated.index, placed.key, placed.channel, siteRun),
    { branch: opts.retention, pr: opts.prRetention },
    run.id,
  );
  await ensureSharedAssets(opts.site, deps.version, deps);
  await placeRunReport(
    deps,
    opts.report,
    join(opts.site, reportPath),
    runAssetsBase(reportPath, deps.version),
  );
  await removePaths(opts.site, [...migrated.remove, ...remove]);
  if (migrated.remove.length > 0)
    say(io, `removed the per-workflow channels ${migrated.remove.join(', ')}; see branch/ and pr/`);
  const rolling = await rebuildRolling(opts.site, placed.key, index, opts.config, deps, io);
  // after the rebuild, which empties the channel folder but for runs/
  const channel = index.channels[placed.key];
  if (channel !== undefined) await writeBadges(opts.site, placed.key, channel);
  await writeSite(opts.site, index, opts.repository);
  await pruneAssets(opts.site, deps, (m) => warning(io, 'site', m));
  setOutputs(io, {
    'report-url': reportUrl(opts.baseUrl.replace(/\/+$/, ''), reportPath),
    channel: placed.key,
    published: 'true',
    rolling,
  });
}

/**
 * Removes pull request `pr`'s channel and folder (`pr/<n>`) from the site and writes `cleaned=true` to
 * $GITHUB_OUTPUT. A pull request the site never had (no channel and no folder) changes nothing and writes
 * `cleaned=false`, so the caller pushes and deploys nothing.
 */
export async function runCleanup(opts: CleanupOptions, io: CliIo, deps: WriterDeps): Promise<void> {
  const key = `pr/${opts.pr}`;
  const current = await readSiteIndex(opts.site, (m) => warning(io, 'cleanup', m));
  if (current.channels[key] === undefined && !existsSync(join(opts.site, key))) {
    say(io, `${key} is not on the site; nothing to remove`);
    setOutputs(io, { cleaned: 'false' });
    return;
  }
  const { index, remove } = removeChannel(current, key);
  await removePaths(opts.site, [...remove, key]);
  await writeSite(opts.site, index, opts.repository);
  await pruneAssets(opts.site, deps, (m) => warning(io, 'cleanup', m));
  say(io, `removed ${key} from the site`);
  setOutputs(io, { cleaned: 'true' });
}
