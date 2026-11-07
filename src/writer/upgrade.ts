import { DEFAULT_LOCAL_WARN_BYTES } from '../config/schema.js';
import type { ManifestV4 } from '../format/manifest.js';
import type { Table } from '../format/parquet/schema.js';
import {
  ASSETS_BASE_RE,
  DEFAULT_ASSETS_BASE,
  LOCK_PATH,
  partitionKey,
  partitionWrapperPath,
} from '../format/paths.js';
import { OtelHtmlError } from '../model/errors.js';
import { assetsInside, pruneOwnAssets } from './assets-cleanup.js';
import { at, writeManifest } from './checkpoint.js';
import { ENGINE_VERSION } from './engine-assets.js';
import { renderIndexHtml } from './html.js';
import { acquireLock } from './lock.js';
import { readMergeInput } from './merge.js';
import { warnIfLocalLarge } from './open-common.js';
import type { FileSystem } from './ports.js';
import type { WriterDeps } from './session.js';
import { writeViewerAssets } from './viewer-assets.js';
import { writeWrapper } from './wrapper-file.js';

export interface UpgradeOptions {
  /** Format 4 only: switch the report between `local` (base64 wrappers, opens from `file://`) and `site`. */
  format?: 'local' | 'site';
  /** Format 4 only: where the report loads its viewer files from (`assets/` or a relative path like `../../assets/0.3.0/`). */
  assetsBase?: string;
  /** With `format: 'local'`: the Parquet size past which the report is better served as `site` (default: the schema's `writer.localWarnBytes`). */
  localWarnBytes?: number;
}

/** Refuses an `assets` folder that is a link out of the report: the viewer files would land wherever it points. */
async function assertAssetsInside(fs: WriterDeps['fs'], dir: string): Promise<void> {
  if (await assetsInside(fs, dir)) return;
  const assets = at(dir, 'assets');
  throw new OtelHtmlError('invalid-report', {
    path: assets,
    expected: 'a folder inside the report',
    actual: await fs.realpath(assets),
  });
}

/** Every Parquet file the manifest lists, with what its wrapper needs. */
function listedFiles(manifest: ManifestV4): { n: number; table: Table; path: string }[] {
  const out: { n: number; table: Table; path: string }[] = [];
  for (const p of manifest.partitions) {
    for (const [table, f] of Object.entries(p.files) as [Table, { path: string }][]) {
      out.push({ n: p.n, table, path: f.path });
    }
  }
  return out;
}

/**
 * Rewrite a report's viewer (`index.html`, `.nojekyll`, `assets/`) with this otel-html's, leaving the data alone.
 * Refused while another writer has the report open. Assets under `assets/` the new viewer did not write are
 * removed (never a subfolder: `assets/<v>/` may be a shared base).
 *
 * A format-4 report can also change `format` (`local` adds the `.parquet.js` wrappers and the base64 engine files,
 * `site` removes them) and `assetsBase`. The writes are ordered so that a crash leaves extra files, not missing
 * ones: wrappers and viewer files (additive) first, then the manifest that names them, then the removals.
 */
export async function upgradeReport(
  deps: WriterDeps,
  dir: string,
  opts: UpgradeOptions = {},
): Promise<{ title: string; formatVersion: number }> {
  const { fs, viewerAssets } = deps;
  const report = await readMergeInput(fs, dir, 'upgrade');
  const { manifest } = report;
  if (report.kind === 'chunks' && (opts.format !== undefined || opts.assetsBase !== undefined)) {
    throw new OtelHtmlError('usage', {
      message: `cannot change the format or assets base of ${report.dir}: it is a format ${report.manifest.formatVersion} report`,
      hint: 'convert it with `otel-html merge <report> -o <out> --format local|site`',
    });
  }
  if (opts.assetsBase !== undefined && !ASSETS_BASE_RE.test(opts.assetsBase)) {
    throw new OtelHtmlError('usage', {
      message: `invalid --assets-base ${JSON.stringify(opts.assetsBase)}`,
      hint: 'use assets/ or a relative path like ../../assets/0.3.0/',
    });
  }
  assertSharedBaseNamed(report, opts);
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
    // Anything may have committed between the first read and the lock; only the copy read under it is current.
    const current = await readMergeInput(fs, report.dir, 'upgrade');
    if (current.kind !== report.kind || current.manifest.formatVersion !== manifest.formatVersion) {
      throw new OtelHtmlError('usage', {
        message: `cannot upgrade ${report.dir}: the report changed while upgrade was starting`,
        hint: 'the report changed while upgrade was starting; run upgrade again',
      });
    }
    if (current.kind === 'partitions') {
      assertSharedBaseNamed(current, opts);
      await upgradePartitioned(deps, report.dir, current.manifest, opts);
    } else {
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
    }
  } finally {
    await lock.release();
  }
  return { title: manifest.title, formatVersion: manifest.formatVersion };
}

/** A format-4 report on a shared base is upgraded only when told the base: the shared copy is the publisher's, so upgrade cannot know it holds this version's files. */
function assertSharedBaseNamed(
  report: { kind: 'chunks'; dir: string } | { kind: 'partitions'; dir: string; manifest: ManifestV4 },
  opts: UpgradeOptions,
): void {
  if (report.kind !== 'partitions' || opts.assetsBase !== undefined) return;
  const { assetsBase } = report.manifest.engine;
  if (assetsBase === DEFAULT_ASSETS_BASE) return;
  throw new OtelHtmlError('usage', {
    message: `cannot upgrade ${report.dir}: it loads its viewer files from ${assetsBase}`,
    hint: "pass --assets-base <base holding this version's files>, or --assets-base assets/ to copy them into the report",
  });
}

async function addWrappers(fs: FileSystem, dir: string, manifest: ManifestV4): Promise<void> {
  for (const f of listedFiles(manifest)) {
    let bytes: Uint8Array;
    try {
      bytes = await fs.readBytes(at(dir, f.path));
    } catch (e) {
      throw new OtelHtmlError('invalid-report', {
        message: `${at(dir, f.path)}: cannot read ${f.path} listed in the manifest (${e instanceof Error ? e.message : String(e)})`,
      });
    }
    await writeWrapper(fs, at(dir, partitionWrapperPath(f.n, f.table)), partitionKey(f.n, f.table), bytes);
  }
}

async function removeWrappers(fs: FileSystem, dir: string, manifest: ManifestV4): Promise<void> {
  for (const f of listedFiles(manifest)) {
    const wrapper = at(dir, partitionWrapperPath(f.n, f.table));
    if ((await fs.entryKind(wrapper)) === 'file') await fs.remove(wrapper);
  }
}

async function upgradePartitioned(
  deps: WriterDeps,
  dir: string,
  manifest: ManifestV4,
  opts: UpgradeOptions,
): Promise<void> {
  const { fs, viewerAssets } = deps;
  const format = opts.format ?? manifest.engine.format;
  const assetsBase = opts.assetsBase ?? manifest.engine.assetsBase;
  const sharedBase = assetsBase !== DEFAULT_ASSETS_BASE;
  const toLocal = format === 'local' && manifest.engine.format === 'site';
  if (format === 'local') {
    let bytes = 0;
    for (const p of manifest.partitions) for (const f of Object.values(p.files)) bytes += f.bytes;
    warnIfLocalLarge(deps.logger, bytes, opts.localWarnBytes ?? DEFAULT_LOCAL_WARN_BYTES);
  }
  if (toLocal) await addWrappers(fs, dir, manifest);
  if (!sharedBase) await writeViewerAssets(fs, dir, viewerAssets, format);
  await fs.writeTextAtomic(
    at(dir, 'index.html'),
    renderIndexHtml(viewerAssets.entry(), manifest.title, { assetsBase }),
  );
  await fs.writeTextAtomic(at(dir, '.nojekyll'), '');
  const engine = { version: ENGINE_VERSION, format, assetsBase };
  if (JSON.stringify(engine) !== JSON.stringify(manifest.engine)) {
    await writeManifest(fs, dir, { ...manifest, engine });
  }
  // Also for a site report that is already site: an earlier upgrade may have died after its manifest write.
  if (format === 'site') await removeWrappers(fs, dir, manifest);
  const viewerFiles = new Set<string>();
  for (const f of await viewerAssets.files()) viewerFiles.add(f.path.split('/')[1] ?? '');
  await pruneOwnAssets(fs, dir, { format, sharedBase, viewerFiles });
}
