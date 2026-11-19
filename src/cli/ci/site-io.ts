import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PartitionEntry } from '../../format/manifest.js';
import { MANIFEST_PATH } from '../../format/paths.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { WriterDeps } from '../../writer/session.js';
import { upgradeReport } from '../../writer/upgrade.js';
import { readRunManifest, renumbered, writeRunReport } from './run-report.js';
import { type Channel, channelBadges, parseSiteIndex, renderLanding, type SiteIndex } from './site.js';

/** The filesystem side of the published site: its index, landing page, and the report folders under it. */

/**
 * `<dir>/index.json`, or an empty index when the site has none yet; channels it cannot read are skipped with `warn`
 * (see `parseSiteIndex`). Throws on a malformed index.
 */
export async function readSiteIndex(dir: string, warn?: (message: string) => void): Promise<SiteIndex> {
  const text = await readFile(join(dir, 'index.json'), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  return parseSiteIndex(text, warn);
}

/** Writes `index.json`, the landing `index.html` and `.nojekyll` into `dir`. */
export async function writeSite(dir: string, index: SiteIndex, repository: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  await writeFile(join(dir, 'index.html'), renderLanding(index, repository));
  await writeFile(join(dir, '.nojekyll'), '');
}

/** Writes the channel's badge files (see `channelBadges`) into `<site>/<key>/`. */
export async function writeBadges(site: string, key: string, channel: Channel): Promise<void> {
  await mkdir(join(site, key), { recursive: true });
  for (const [name, badge] of Object.entries(channelBadges(channel))) {
    await writeFile(join(site, key, name), `${JSON.stringify(badge)}\n`);
  }
}

/** Replaces `to` with a copy of the report folder `from`. */
export async function copyReport(from: string, to: string): Promise<void> {
  await rm(to, { recursive: true, force: true });
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

/** Removes each relative path under `dir`. Throws, removing nothing, when a path is absolute or leaves `dir`. */
export async function removePaths(dir: string, rel: string[]): Promise<void> {
  const root = resolve(dir);
  const targets = rel.map((p) => {
    const target = resolve(root, p);
    const back = relative(root, target);
    if (isAbsolute(p) || back === '' || back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back))
      throw new Error(`refusing to remove ${p}: it is not inside ${dir}`);
    return target;
  });
  for (const t of targets) await rm(t, { recursive: true, force: true });
}

/**
 * Replaces `to` with a copy of the run report `from` (a format-5 report with its own `assets/`, from `ci report`),
 * switched to `site` format with its viewer files at `assetsBase`: `upgrade --format site --assets-base`, which
 * R57 requires to name the base even when it is the same. The emptied `assets/` folder is removed.
 *
 * With `opts.renumberFrom` (D54) `to` is not removed: the report is upgraded in a scratch copy, its partitions are
 * renumbered to start at `renumberFrom` (so no path in `to` ever names two files), and the copy is laid over `to`.
 * The files `to` already holds stay where they are; the new manifest simply no longer lists them.
 */
export async function placeRunReport(
  deps: WriterDeps,
  from: string,
  to: string,
  assetsBase: string,
  opts?: { renumberFrom: number },
): Promise<void> {
  if (opts === undefined) {
    await copyReport(from, to);
    await finishRunReport(deps, to, assetsBase);
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'otel-html-place-'));
  try {
    const copy = join(scratch, 'report');
    await cp(from, copy, { recursive: true });
    await finishRunReport(deps, copy, assetsBase);
    const manifest = await readRunManifest(deps.fs, copy);
    if (manifest === null)
      throw new OtelHtmlError('invalid-report', { path: from, expected: `a report with ${MANIFEST_PATH}` });
    const shifted = renumbered(manifest, opts.renumberFrom);
    for (const m of shifted.moves) {
      await mkdir(dirname(join(copy, m.to)), { recursive: true });
      await rename(join(copy, m.from), join(copy, m.to));
    }
    // folders no partition of the new manifest lives in (a partition that moved away leaves one behind)
    const live = new Set(shifted.manifest.partitions.flatMap((p) => folderNames(p.files)));
    for (const e of await readdir(join(copy, 'data', 'partitions')).catch(() => [] as string[]))
      if (!live.has(e)) await rm(join(copy, 'data', 'partitions', e), { recursive: true, force: true });
    await writeRunReport(deps, copy, shifted.manifest);
    await mkdir(to, { recursive: true });
    await cp(copy, to, { recursive: true, force: true });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The `<p6>` folder names of a partition's files (`data/partitions/<p6>/<table>.parquet`). */
const folderNames = (files: PartitionEntry['files']): string[] =>
  Object.values(files).flatMap((f) => (f === undefined ? [] : [f.path.split('/')[2] ?? '']));

async function finishRunReport(deps: WriterDeps, dir: string, assetsBase: string): Promise<void> {
  await upgradeReport(deps, dir, { format: 'site', assetsBase });
  await rmdir(join(dir, 'assets')).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') throw e;
  });
}
