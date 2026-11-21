import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { reviveDataJson, unwrapDataFile } from '../../format/data-file.js';
import { engineAssetNames } from '../../format/engine.js';
import { MANIFEST_KEY, MANIFEST_PATH } from '../../format/paths.js';
import { readMergeInput } from '../../writer/merge.js';
import type { WriterDeps } from '../../writer/session.js';

/**
 * The site's one flat `assets/` folder: every report's viewer, engine and extension files, named by content (the
 * viewer's `viewer.<hash>.js|css`, the engine files by the pinned DuckDB version), shared by every report on the site.
 */

const SHARED = 'assets';
const LINK_RE = /(?:src|href)="([^"]*)"/g;
const VERSIONED_BASE_RE = /^(?:\.\.\/)*assets\/([^/]+)\/$/;

/** Writes this build's `site` viewer files to `<site>/assets/<name>`; a file already there stays as it is. */
export async function ensureSharedAssets(site: string, deps: WriterDeps): Promise<void> {
  const root = join(site, SHARED);
  // A crashed publish leaves its scratch files behind; each publish works in its own checkout, so none is live.
  for (const e of await readdir(root).catch(() => [] as string[])) {
    if (e.includes('.tmp-')) await rm(join(root, e), { recursive: true, force: true });
  }
  for (const f of await deps.viewerAssets.files('site')) {
    const dest = join(root, f.path.replace(/^assets\//, ''));
    if (await present(dest)) continue;
    await writeAside(dest, f.contents);
  }
}

async function writeAside(dest: string, contents: Uint8Array): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.tmp-${process.pid}`;
  await writeFile(part, contents);
  await rename(part, dest);
}

const present = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/** The report folders under `dir` (any depth up to the run folders: `<kind>/<name>/runs/<id>`), skipping `assets/`. */
async function reportFolders(dir: string, depth = 0): Promise<string[]> {
  const found: string[] = [];
  if (await present(join(dir, MANIFEST_PATH))) found.push(dir);
  if (depth >= 4) return found;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || e.name.startsWith('.') || (depth === 0 && e.name === SHARED)) continue;
    found.push(...(await reportFolders(join(dir, e.name), depth + 1)));
  }
  return found;
}

interface EngineInfo {
  assetsBase: string;
  version: string;
}

/**
 * The `engine` of the report in `folder`; undefined for a chunk report (it has none). A format-4 report is refused by
 * every reader now but its page still opens in its own viewer, so it is read from the raw JSON without validation.
 */
async function engineOf(deps: WriterDeps, folder: string): Promise<EngineInfo | undefined> {
  const path = `${folder.replace(/[\\/]+$/, '')}/${MANIFEST_PATH}`;
  if (await deps.fs.exists(path)) {
    try {
      const raw: unknown = reviveDataJson(unwrapDataFile(await deps.fs.readText(path), MANIFEST_KEY));
      if (typeof raw === 'object' && raw !== null && 'formatVersion' in raw && raw.formatVersion === 4) {
        const engine = 'engine' in raw ? raw.engine : undefined;
        if (typeof engine !== 'object' || engine === null) return undefined;
        const base = 'assetsBase' in engine ? engine.assetsBase : undefined;
        const version = 'version' in engine ? engine.version : undefined;
        return typeof base === 'string' && typeof version === 'string'
          ? { assetsBase: base, version }
          : undefined;
      }
    } catch {
      // not readable here: `readMergeInput` below says why
    }
  }
  const input = await readMergeInput(deps.fs, folder, 'prune-assets');
  return input.kind === 'partitions'
    ? { assetsBase: input.manifest.engine.assetsBase, version: input.manifest.engine.version }
    : undefined;
}

const toSiteRel = (site: string, folder: string): string => relative(site, folder).split(sep).join('/');

/** The site-relative `assets/…` paths the `src`/`href` values of the report's page resolve to. */
async function pageAssets(deps: WriterDeps, folder: string, rel: string): Promise<string[]> {
  const page = join(folder, 'index.html');
  if (!(await deps.fs.exists(page))) return [];
  const text = await deps.fs.readText(page);
  const found: string[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const path = posix.normalize(posix.join(rel, m[1] ?? ''));
    if (path.startsWith(`${SHARED}/`) && !path.split('/').includes('..')) found.push(path);
  }
  return found;
}

interface ReportRefs {
  folder: string;
  rel: string;
  engine: EngineInfo | undefined;
  /** Files named by the page and the engine, site-relative. */
  files: string[];
  /** The `assets/<version>/` prefix the manifest base names, when it does. */
  versioned: string | undefined;
}

async function readRefs(site: string, deps: WriterDeps, folder: string): Promise<ReportRefs> {
  const rel = toSiteRel(site, folder);
  const files = await pageAssets(deps, folder, rel);
  const engine = await engineOf(deps, folder);
  let versioned: string | undefined;
  if (engine !== undefined) {
    const base = posix.normalize(posix.join(rel, engine.assetsBase));
    if (base === `${SHARED}/`)
      files.push(...engineAssetNames('site', engine.version).map((n) => `${SHARED}/${n}`));
    else if (VERSIONED_BASE_RE.test(base)) versioned = base;
  }
  return { folder, rel, engine, files, versioned };
}

/**
 * The site-relative paths every report under `site` references: its page's `src`/`href` values that land in
 * `assets/`, its engine files when the manifest base is the flat folder, and (a folder prefix ending in `/`) the
 * whole `assets/<version>/` folder when the base is a versioned one. `null` (after `warn`) when a report cannot be
 * read: nothing may be pruned then.
 */
export async function referencedAssets(
  site: string,
  deps: WriterDeps,
  warn: (message: string) => void,
): Promise<Set<string> | null> {
  const referenced = new Set<string>();
  for (const folder of await reportFolders(site)) {
    try {
      const refs = await readRefs(site, deps, folder);
      for (const f of refs.files) referenced.add(f);
      if (refs.versioned !== undefined) referenced.add(refs.versioned);
    } catch (e) {
      warn(`assets not pruned: cannot read ${folder}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
  return referenced;
}

async function filesUnder(dir: string, deps: WriterDeps, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await deps.fs.list(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const kind = await deps.fs.entryKind(path);
    if (kind === 'dir') out.push(...(await filesUnder(path, deps, `${prefix}${name}/`)));
    else if (kind !== 'missing') out.push(`${prefix}${name}`);
  }
  return out;
}

/**
 * The site-relative paths of the files under `assets/` (any depth) that no report references, by path or by a
 * referenced folder prefix. Removes nothing: the deployer schedules the deletion. `[]` when a report cannot be read.
 * `known` is the result of `referencedAssets` when the caller already has it.
 */
export async function pruneAssets(
  site: string,
  deps: WriterDeps,
  warn: (message: string) => void = () => {},
  known?: Set<string> | null,
): Promise<string[]> {
  const referenced = known === undefined ? await referencedAssets(site, deps, warn) : known;
  if (referenced === null) return [];
  const prefixes = [...referenced].filter((p) => p.endsWith('/'));
  return (await filesUnder(join(site, SHARED), deps, `${SHARED}/`)).filter(
    (p) => !referenced.has(p) && !prefixes.some((x) => p.startsWith(x)),
  );
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/**
 * Moves the reports on a versioned base (`assets/<version>/`) to the flat one: copies the files each references
 * to `assets/<name>` (when absent), rewrites its page and the base text of its manifest. A report with a file
 * missing from the version folder, or whose manifest text holds the base other than once, is left untouched with a
 * `warn`. Returns the migrated folders (site-relative). A report already on the flat base matches nothing.
 */
export async function migrateAssetsBases(
  site: string,
  deps: WriterDeps,
  warn: (message: string) => void,
): Promise<string[]> {
  const migrated: string[] = [];
  for (const folder of await reportFolders(site)) {
    const rel = toSiteRel(site, folder);
    try {
      const refs = await readRefs(site, deps, folder);
      const oldBase = refs.engine?.assetsBase;
      if (oldBase === undefined || refs.engine === undefined) continue;
      const m = VERSIONED_BASE_RE.exec(oldBase);
      if (m === null) continue;
      const prefix = `${SHARED}/${m[1]}/`;
      if (posix.normalize(posix.join(rel, oldBase)) !== prefix) continue;
      const manifestPath = join(folder, MANIFEST_PATH);
      const manifestText = await deps.fs.readText(manifestPath);
      const needle = `"assetsBase":"${oldBase}"`;
      if (count(manifestText, needle) !== 1) {
        warn(`${rel}: not migrated, its manifest does not name ${oldBase} exactly once`);
        continue;
      }
      const names = new Set(
        [...refs.files, ...engineAssetNames('site', refs.engine.version).map((n) => `${prefix}${n}`)]
          .filter((f) => f.startsWith(prefix))
          .map((f) => f.slice(prefix.length)),
      );
      let missing: string | undefined;
      for (const n of names) {
        if (!(await present(join(site, prefix, n)))) {
          missing = n;
          break;
        }
      }
      if (missing !== undefined) {
        warn(`${rel}: not migrated, ${prefix}${missing} is missing`);
        continue;
      }
      for (const n of names) {
        const dest = join(site, SHARED, n);
        if (await present(dest)) continue;
        await writeAside(dest, await deps.fs.readBytes(join(site, prefix, n)));
      }
      const flat = `${'../'.repeat(rel.split('/').filter((x) => x !== '').length)}${SHARED}/`;
      const pagePath = join(folder, 'index.html');
      if (await deps.fs.exists(pagePath)) {
        // every quoted string that starts with the old base: the src=/href= values and the inline prefetch's hrefs
        const page = (await deps.fs.readText(pagePath)).replaceAll(`"${oldBase}`, `"${flat}`);
        await deps.fs.writeTextAtomic(pagePath, page);
      }
      await deps.fs.writeTextAtomic(manifestPath, manifestText.replace(needle, `"assetsBase":"${flat}"`));
      migrated.push(rel);
    } catch (e) {
      warn(`${rel}: not migrated: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return migrated;
}
