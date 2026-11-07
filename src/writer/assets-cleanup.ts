import { basename, dirname } from 'node:path';
import type { ReportFormat } from '../config/schema.js';
import { ENGINE_ASSET_RE } from '../format/paths.js';
import { at } from './checkpoint.js';
import type { FileSystem } from './ports.js';
import { wantsAsset } from './viewer-assets.js';

/** The viewer's own files by name, which a report with a shared assets base has no use for. */
const VIEWER_FILE_RE = /^viewer\.[A-Za-z0-9._-]+$/;

/**
 * False when the report's `assets` folder exists but is a link out of the report (one copied from elsewhere may be):
 * whatever is written or removed there would land wherever it points. A missing folder counts as inside.
 */
export async function assetsInside(fs: FileSystem, dir: string): Promise<boolean> {
  const assets = at(dir, 'assets');
  if (!(await fs.exists(assets))) return true;
  const real = await fs.realpath(assets);
  // On-disk case may differ from `assets` on a case-insensitive file system.
  return dirname(real) === (await fs.realpath(dir)) && basename(real).toLowerCase() === 'assets';
}

/**
 * Removes dead files from the report's own `assets/` after a session wrote it (or chose not to):
 *
 * - engine files (`ENGINE_ASSET_RE`) that this `format` and engine version do not load;
 * - with `sharedBase`, every engine file and the viewer's own `viewer.*` files: the report loads them from
 *   elsewhere, so what an earlier session left here is dead weight.
 *
 * - with `viewerFiles` (the names this build wrote), the `viewer.*` files not among them: an older viewer's.
 *
 * Only top-level names that are regular files are considered: a subfolder (`assets/<v>/` is a legal base, even one
 * named like `viewer.0.3.0`) and a symbolic link are skipped. A shared base outside the report is never visited, and
 * an `assets/` that links out of the report is not touched at all (returns false). A missing `assets/` is fine.
 */
export async function pruneOwnAssets(
  fs: FileSystem,
  out: string,
  opts: { format: ReportFormat | undefined; sharedBase: boolean; viewerFiles?: ReadonlySet<string> },
): Promise<boolean> {
  if (!(await assetsInside(fs, out))) return false;
  const dir = at(out, 'assets');
  if (!(await fs.exists(dir))) return true;
  for (const name of await fs.list(dir)) {
    const path = `assets/${name}`;
    const deadEngine = ENGINE_ASSET_RE.test(path) && (opts.sharedBase || !wantsAsset(path, opts.format));
    const deadViewer =
      VIEWER_FILE_RE.test(name) &&
      (opts.sharedBase || (opts.viewerFiles !== undefined && !opts.viewerFiles.has(name)));
    if ((deadEngine || deadViewer) && (await fs.entryKind(at(dir, name))) === 'file') {
      await fs.remove(at(dir, name));
    }
  }
  return true;
}
