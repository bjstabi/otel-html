import type { ReportFormat } from '../config/schema.js';
import { ENGINE_ASSET_RE } from '../format/paths.js';
import { at } from './checkpoint.js';
import type { FileSystem } from './ports.js';
import { wantsAsset } from './viewer-assets.js';

/** The viewer's own files by name, which a report with a shared assets base has no use for. */
const VIEWER_FILE_RE = /^viewer\.[A-Za-z0-9._-]+$/;

/**
 * Removes dead files from the report's own `assets/` after a session wrote it (or chose not to):
 *
 * - engine files (`ENGINE_ASSET_RE`) that this `format` and engine version do not load;
 * - with `sharedBase`, every engine file and the viewer's own `viewer.*` files: the report loads them from
 *   elsewhere, so what an earlier session left here is dead weight.
 *
 * Only top-level names are considered, by name, and a subfolder (`assets/<v>/` is a legal base) matches neither
 * pattern, so it stays. A shared base outside the report is never visited. A missing `assets/` is fine.
 */
export async function pruneOwnAssets(
  fs: FileSystem,
  out: string,
  opts: { format: ReportFormat; sharedBase: boolean },
): Promise<void> {
  const dir = at(out, 'assets');
  if (!(await fs.exists(dir))) return;
  for (const name of await fs.list(dir)) {
    const path = `assets/${name}`;
    const deadEngine = ENGINE_ASSET_RE.test(path) && (opts.sharedBase || !wantsAsset(path, opts.format));
    const deadViewer = opts.sharedBase && VIEWER_FILE_RE.test(name);
    if (deadEngine || deadViewer) await fs.remove(at(dir, name));
  }
}
