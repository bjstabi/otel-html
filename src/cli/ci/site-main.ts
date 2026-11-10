import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import { messageOf, say, warning } from './github-api.js';
import { mergeSkippingBad, mergeWithConfig } from './publish-io.js';
import {
  applyRetention,
  type Channel,
  dropWorkflowChannels,
  placeRun,
  removeChannel,
  renderRedirect,
  rollingInputs,
  type SiteIndex,
  type SiteRun,
} from './site.js';
import {
  ensureSharedAssets,
  placeRunReport,
  pruneAssets,
  readSiteIndex,
  writeBadges,
  writeSite,
} from './site-io.js';

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
export const runAssetsBase = (reportPath: string, version: string): string =>
  `${up(reportPath)}assets/${version}/`;

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

export interface PlaceOptions {
  retention: number;
  prRetention: number;
  /** The dashboard config file for the rolling report. */
  config: string | undefined;
  repository: string;
  deps: WriterDeps;
  io: CliIo;
  /** How dropped report folders leave the site: `removePaths` now, a scheduled deletion in the deployer (D66). */
  remove: (site: string, paths: string[]) => Promise<void>;
  /** D54: place the report beside the run folder's existing partitions, numbered from here, removing nothing. */
  renumberFrom?: number;
}

/**
 * Places a finished run's report (`report`) at `siteRun.reportPath` on the site, in channel `placed`: applies
 * retention, drops the older per-workflow channels (`ci/`, `load/`) and rewrites the index, landing page and the
 * channel's rolling report and badges. What leaves the site goes through `o.remove`.
 */
export async function placeFinishedRun(
  site: string,
  placed: { key: string; channel: Omit<Channel, 'runs'> },
  siteRun: SiteRun,
  report: string,
  o: PlaceOptions,
): Promise<{ rolling: 'built' | 'stub' }> {
  const { deps, io } = o;
  const { reportPath } = siteRun;
  const migrated = dropWorkflowChannels(await readSiteIndex(site, (m) => warning(io, 'site', m)));
  const { index, remove } = applyRetention(
    placeRun(migrated.index, placed.key, placed.channel, siteRun),
    { branch: o.retention, pr: o.prRetention },
    siteRun.runId,
  );
  await placeRunReport(
    deps,
    report,
    join(site, reportPath),
    runAssetsBase(reportPath, deps.version),
    o.renumberFrom === undefined ? undefined : { renumberFrom: o.renumberFrom },
  );
  await o.remove(site, [...migrated.remove, ...remove]);
  // after the removals: a legacy channel named `assets` is the shared folder's path
  await ensureSharedAssets(site, deps.version, deps);
  if (migrated.remove.length > 0)
    say(io, `removed the per-workflow channels ${migrated.remove.join(', ')}; see branch/ and pr/`);
  const rolling = await rebuildRolling(site, placed.key, index, o.config, deps, io);
  // after the rebuild, which empties the channel folder but for runs/
  const channel = index.channels[placed.key];
  if (channel !== undefined) await writeBadges(site, placed.key, channel);
  await writeSite(site, index, o.repository);
  await pruneAssets(site, deps, (m) => warning(io, 'site', m));
  return { rolling };
}

/**
 * Removes pull request `pr`'s channel and folder (`pr/<n>`) from the site (through `remove`) and rewrites the index
 * and landing page. A pull request the site never had (no channel and no folder) changes nothing: `false`.
 */
export async function removePullRequest(
  site: string,
  pr: number,
  repository: string,
  deps: WriterDeps,
  io: CliIo,
  remove: (site: string, paths: string[]) => Promise<void>,
): Promise<boolean> {
  const key = `pr/${pr}`;
  const current = await readSiteIndex(site, (m) => warning(io, 'cleanup', m));
  if (current.channels[key] === undefined && !existsSync(join(site, key))) {
    say(io, `${key} is not on the site; nothing to remove`);
    return false;
  }
  const removed = removeChannel(current, key);
  await remove(site, [...removed.remove, key]);
  await writeSite(site, removed.index, repository);
  await pruneAssets(site, deps, (m) => warning(io, 'cleanup', m));
  say(io, `removed ${key} from the site`);
  return true;
}
