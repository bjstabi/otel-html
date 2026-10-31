import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseSiteIndex, renderLanding, type SiteIndex } from './site.js';

/** The filesystem side of the published site: its index, landing page, and the report folders under it. */

/** `<dir>/index.json`, or an empty index when the site has none yet. Throws on a malformed index. */
export async function readSiteIndex(dir: string): Promise<SiteIndex> {
  const text = await readFile(join(dir, 'index.json'), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  return parseSiteIndex(text);
}

/** Writes `index.json`, the landing `index.html` and `.nojekyll` into `dir`. */
export async function writeSite(dir: string, index: SiteIndex, repository: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  await writeFile(join(dir, 'index.html'), renderLanding(index, repository));
  await writeFile(join(dir, '.nojekyll'), '');
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
    if (isAbsolute(p) || back === '' || back.startsWith('..') || isAbsolute(back))
      throw new Error(`refusing to remove ${p}: it is not inside ${dir}`);
    return target;
  });
  for (const t of targets) await rm(t, { recursive: true, force: true });
}
