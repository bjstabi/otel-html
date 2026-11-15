import { basename, dirname } from 'node:path';
import type { ReportFormat } from '../config/schema.js';
import { DEFAULT_ASSETS_BASE, ENGINE_ASSET_RE } from '../format/paths.js';
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

/** The path as one shell word, so a hint's command can be pasted. */
function shellWord(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * What to do about an `assets/` that links out of `out`. What the report records decides: on a shared base the
 * answer is to keep that base; otherwise (and only when the data is to be kept) `upgrade` onto a shared base that
 * already holds this version's viewer files comes first.
 */
export function linkedAssetsHint(
  out: string,
  opts: { recorded?: string | undefined; replacing?: boolean } = {},
): string {
  const { recorded, replacing = false } = opts;
  if (recorded !== undefined && recorded !== DEFAULT_ASSETS_BASE) {
    return `the report already records the shared assets base ${recorded}: use --assets-base ${recorded}`;
  }
  const folder = 'replace the assets link with a real folder (a copy of its target)';
  const startOver = 'start the report over with --replace and --assets-base, which discards its data';
  if (replacing) return `${startOver}, or ${folder}`;
  return `run \`otel-html upgrade ${shellWord(out)} --assets-base <shared base>\` to keep the data and load the viewer files from a shared base; the base must already hold this version's viewer files: assets/<version>/ inside the link's target (reached through the report's own link), or a site's ../…/assets/<version>/ (upgrade only warns when a base on this disk lacks them); then append with the same --assets-base. A link to a flat folder of viewer files cannot be named as a base: ${folder}, or ${startOver}`;
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
