import { basename, dirname } from 'node:path';
import { LOCK_PATH } from '../format/paths.js';
import { OtelHtmlError } from '../model/errors.js';
import { at } from './checkpoint.js';
import { renderIndexHtml } from './html.js';
import { acquireLock } from './lock.js';
import { readReportManifest } from './merge.js';
import type { WriterDeps } from './session.js';
import { writeViewerAssets } from './viewer-assets.js';

/**
 * Refuses an `assets` folder that is a link out of the report (one copied from elsewhere may be): the viewer files
 * would land wherever it points. Links at the files themselves are replaced, not followed, by the writes.
 */
async function assertAssetsInside(fs: WriterDeps['fs'], dir: string): Promise<void> {
  const assets = at(dir, 'assets');
  if (!(await fs.exists(assets))) return;
  const real = await fs.realpath(assets);
  // On-disk case may differ from `assets` on a case-insensitive file system.
  if (dirname(real) === (await fs.realpath(dir)) && basename(real).toLowerCase() === 'assets') return;
  throw new OtelHtmlError('invalid-report', {
    path: assets,
    expected: 'a folder inside the report',
    actual: real,
  });
}

/**
 * Rewrite a report's viewer (`index.html`, `.nojekyll`, `assets/`) with this otel-html's, leaving `data/`
 * alone. Refused while another writer has the report open. Assets under `assets/` the new viewer did not
 * write are removed.
 */
export async function upgradeReport(
  deps: WriterDeps,
  dir: string,
): Promise<{ title: string; formatVersion: number }> {
  const { fs, viewerAssets } = deps;
  const report = await readReportManifest(fs, dir, 'upgrade');
  const { manifest } = report;
  await assertAssetsInside(fs, report.dir);
  // Holding the writer lock for the rewrite also keeps a writer from starting underneath it.
  const lock = await acquireLock(deps, at(report.dir, LOCK_PATH)).catch((e: unknown) => {
    if (e instanceof OtelHtmlError && e.code === 'report-locked') {
      throw new OtelHtmlError('usage', {
        message: `cannot upgrade ${report.dir}: ${e.actual ?? 'the report is locked'}`,
        hint: 'another otel-html has the report open',
      });
    }
    throw e;
  });
  try {
    const written = new Set<string>();
    for (const f of await viewerAssets.files()) written.add(f.path.split('/')[1] ?? '');
    await writeViewerAssets(fs, report.dir, viewerAssets);
    await fs.writeTextAtomic(
      at(report.dir, 'index.html'),
      renderIndexHtml(viewerAssets.entry(), manifest.title),
    );
    await fs.writeTextAtomic(at(report.dir, '.nojekyll'), '');
    for (const name of await fs.list(at(report.dir, 'assets'))) {
      if (!written.has(name)) await fs.remove(at(report.dir, `assets/${name}`));
    }
  } finally {
    await lock.release();
  }
  return { title: manifest.title, formatVersion: manifest.formatVersion };
}
