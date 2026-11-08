import { cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ASSETS_BASE_RE, MANIFEST_PATH } from '../../format/paths.js';
import { readMergeInput } from '../../writer/merge.js';
import type { WriterDeps } from '../../writer/session.js';
import { upgradeReport } from '../../writer/upgrade.js';
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
 * Replaces `to` with a copy of the run report `from` (a format-4 report with its own `assets/`, from `ci report`),
 * switched to `site` format with its viewer files at `assetsBase`: `upgrade --format site --assets-base`, which
 * R57 requires to name the base even when it is the same. The emptied `assets/` folder is removed.
 */
export async function placeRunReport(
  deps: WriterDeps,
  from: string,
  to: string,
  assetsBase: string,
): Promise<void> {
  await copyReport(from, to);
  await upgradeReport(deps, to, { format: 'site', assetsBase });
  await rmdir(join(to, 'assets')).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') throw e;
  });
}

const SHARED = 'assets';

/**
 * Makes `<site>/assets/<version>/` hold this build's `site` viewer files (the viewer, the engine and the DuckDB
 * extensions, plain). A new folder is written aside and renamed into place: a failed publish never leaves a
 * half-filled version that later publishes would trust. An existing folder gets the files it lacks and keeps the
 * ones it has untouched: every name is unique to its content (the viewer's `viewer.<hash>.js|css`, the engine
 * files named by the pinned DuckDB version), so two builds of one version, which differ only in the viewer hash,
 * live side by side and reports of either keep their files. The extra viewer files go when the version is pruned.
 */
export async function ensureSharedAssets(site: string, version: string, deps: WriterDeps): Promise<void> {
  const target = join(site, SHARED, version);
  // A crashed publish leaves its scratch folder behind (another pid names the next one); a later `git add -A` of the
  // site would commit it. Each publish works in its own checkout, so no scratch folder here belongs to a live one.
  for (const e of await readdir(join(site, SHARED)).catch(() => [] as string[])) {
    if (/^\..*\.tmp-/.test(e)) await rm(join(site, SHARED, e), { recursive: true, force: true });
  }
  const files = await deps.viewerAssets.files('site');
  const rel = (f: { path: string }): string => f.path.replace(/^assets\//, '');
  if (await exists(target)) {
    for (const f of files) {
      const dest = join(target, rel(f));
      if (await present(dest)) continue;
      await mkdir(dirname(dest), { recursive: true });
      const part = `${dest}.tmp-${process.pid}`;
      await writeFile(part, f.contents);
      await rename(part, dest);
    }
    return;
  }
  const scratch = join(site, SHARED, `.${version}.tmp-${process.pid}`);
  try {
    for (const f of files) {
      await mkdir(dirname(join(scratch, rel(f))), { recursive: true });
      await writeFile(join(scratch, rel(f)), f.contents);
    }
    await mkdir(join(site, SHARED), { recursive: true });
    await rename(scratch, target);
  } catch (e) {
    await rm(scratch, { recursive: true, force: true });
    throw e;
  }
}

const present = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Whether `p` is a folder with something in it: an empty version folder (a manual or partial copy) is not complete. */
const exists = (p: string): Promise<boolean> =>
  readdir(p).then(
    (names) => names.length > 0,
    () => false,
  );

/** The report folders under `dir` (any depth up to the run folders: `<kind>/<name>/runs/<id>`), skipping `assets/`. */
async function reportFolders(dir: string, depth = 0): Promise<string[]> {
  const found: string[] = [];
  if (
    await readFile(join(dir, MANIFEST_PATH)).then(
      () => true,
      () => false,
    )
  )
    found.push(dir);
  if (depth >= 4) return found;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith('.') || (depth === 0 && e.name === SHARED)) continue;
    found.push(...(await reportFolders(join(dir, e.name), depth + 1)));
  }
  return found;
}

/**
 * Removes the `<site>/assets/<version>/` folders no report under `<site>` loads its viewer files from (each
 * manifest's `engine.assetsBase`). Returns the versions removed. A report whose manifest cannot be read might
 * reference any version, so nothing is removed then (`warn` says why).
 */
export async function pruneAssets(
  site: string,
  deps: WriterDeps,
  warn: (message: string) => void = () => {},
): Promise<string[]> {
  const referenced = new Set<string>();
  for (const folder of await reportFolders(site)) {
    try {
      const input = await readMergeInput(deps.fs, folder, 'prune-assets');
      if (input.kind !== 'partitions') continue;
      const base = input.manifest.engine.assetsBase;
      if (!ASSETS_BASE_RE.test(base)) continue;
      // the segment after the last `assets` (a version may itself be named `assets`)
      const segments = base.split('/').filter((x) => x !== '');
      const version = segments[segments.lastIndexOf(SHARED, segments.length - 2) + 1];
      if (segments.length < 2 || version === undefined) continue;
      referenced.add(version);
    } catch (e) {
      warn(`assets not pruned: cannot read ${folder}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }
  const removed: string[] = [];
  const entries = await readdir(join(site, SHARED), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || referenced.has(e.name)) continue;
    await rm(join(site, SHARED, e.name), { recursive: true, force: true });
    removed.push(e.name);
  }
  return removed;
}
