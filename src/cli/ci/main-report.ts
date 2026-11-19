import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ResolvedConfig } from '../../config/schema.js';
import { wrapDataFile } from '../../format/data-file.js';
import {
  type ManifestV4,
  manifestForWrite,
  type PartitionEntry,
  parseAnyManifest,
} from '../../format/manifest.js';
import { TABLES } from '../../format/parquet/columns.js';
import { MANIFEST_KEY, MANIFEST_PATH } from '../../format/paths.js';
import { OtelHtmlError } from '../../model/errors.js';
import { renderIndexHtml } from '../../writer/html.js';
import type { WriterDeps } from '../../writer/session.js';
import { entryFrom, newRunManifest, readRunManifest, totalsAndRange, writeRunReport } from './run-report.js';

/** The `source` of the partitions that run `runId`, attempt `attempt`, contributes to the one report. */
export const runSource = (runId: number, attempt: number): string => `run:${runId}#${attempt}`;

/** What every attempt's `source` of run `runId` starts with. */
export const runSourcePrefix = (runId: number): string => `run:${runId}#`;

/** The run and attempt of a `run:<id>#<attempt>` source; `undefined` for any other source. */
export function sourceRun(source: string): { runId: number; attempt: number } | undefined {
  const m = /^run:(\d+)#(\d+)$/.exec(source);
  return m === null ? undefined : { runId: Number(m[1]), attempt: Number(m[2]) };
}

/** One above the highest `data/partitions/<p6>/` folder (the high-water mark, including folders awaiting deletion). */
export async function diskNext(reportDir: string): Promise<number> {
  let next = 0;
  for (const name of await readdir(join(reportDir, 'data', 'partitions')).catch(() => [] as string[])) {
    if (/^\d+$/.test(name)) next = Math.max(next, Number(name) + 1);
  }
  return next;
}

const filePathsOf = (e: PartitionEntry): string[] => TABLES.flatMap((t) => e.files[t]?.path ?? []);

/**
 * The one report at `dir` exists and carries `config`, this build's version and `assetsBase`: created (complete,
 * format 8, `site`) when `data/manifest.js` is absent, else its `config`, `otelHtmlVersion`, `engine.assetsBase` and a
 * lower `formatVersion` are patched, written only when something differs. `index.html` is rewritten when its text would
 * differ, `.nojekyll` when absent. Returns the report-relative paths written.
 */
export async function ensureMainReport(
  deps: WriterDeps,
  dir: string,
  config: ResolvedConfig,
  o: { now: string; assetsBase: string },
): Promise<string[]> {
  const fresh = newRunManifest({
    title: config.title ?? 'CI',
    createdAt: o.now,
    assetsBase: o.assetsBase,
    config,
    version: deps.version,
  });
  const existing = await readRunManifest(deps.fs, dir);
  if (existing === null) {
    await writeRunReport(deps, dir, { ...fresh, complete: true });
    return [MANIFEST_PATH, 'index.html', '.nojekyll'];
  }
  const patched: ManifestV4 = {
    ...existing,
    formatVersion: 8, // the newest format; a lower one is upgraded
    otelHtmlVersion: fresh.otelHtmlVersion,
    engine: { ...existing.engine, assetsBase: o.assetsBase },
    config: fresh.config,
  };
  const written: string[] = [];
  if (JSON.stringify(manifestForWrite(patched)) !== JSON.stringify(manifestForWrite(existing))) {
    await deps.fs.writeTextAtomic(
      `${dir}/${MANIFEST_PATH}`,
      wrapDataFile(MANIFEST_KEY, manifestForWrite(patched)),
    );
    written.push(MANIFEST_PATH);
  }
  const html = renderIndexHtml(deps.viewerAssets.entry(), patched.title, { assetsBase: o.assetsBase });
  const htmlPath = `${dir}/index.html`;
  if (!(await deps.fs.exists(htmlPath)) || (await deps.fs.readText(htmlPath)) !== html) {
    await deps.fs.writeTextAtomic(htmlPath, html);
    written.push('index.html');
  }
  if (!(await deps.fs.exists(`${dir}/.nojekyll`))) {
    await deps.fs.writeTextAtomic(`${dir}/.nojekyll`, '');
    written.push('.nojekyll');
  }
  return written;
}

/**
 * Replaces run `run.runId`'s partitions in the one report at `dir`: every partition whose `source` starts with
 * `runSourcePrefix(run.runId)` (any attempt) is dropped and, when `from` is given, its partitions are added under
 * `run:<id>#<attempt>`, numbered upward from `max(o.next, diskNext(dir), highest n + 1)`, their files copied. Nothing
 * is deleted: `dropped` lists the dropped partitions' files (report-relative) for the deployer to delete later.
 * `next` is one past the highest number used.
 */
export async function replaceRunPartitions(
  deps: WriterDeps,
  dir: string,
  from: { dir: string; manifest: ManifestV4 } | null,
  run: { runId: number; attempt: number },
  o: { now: string; next: number },
): Promise<{ written: string[]; dropped: string[]; next: number }> {
  const manifest = await readRunManifest(deps.fs, dir);
  if (manifest === null)
    throw new OtelHtmlError('invalid-report', {
      path: `${dir}/${MANIFEST_PATH}`,
      expected: 'the one report',
    });
  const prefix = runSourcePrefix(run.runId);
  const dropped = manifest.partitions.filter((e) => e.source.startsWith(prefix));
  const kept = manifest.partitions.filter((e) => !e.source.startsWith(prefix));
  let next = Math.max(o.next, await diskNext(dir), ...manifest.partitions.map((e) => e.n + 1));
  const copies: { fromDir: string; from: string; to: string }[] = [];
  const added = (from?.manifest.partitions ?? []).map((p) =>
    entryFrom(
      next++,
      { ...p, source: runSource(run.runId, run.attempt) },
      from?.dir ?? '',
      manifest.statisticsKeys,
      copies,
    ),
  );
  for (const m of copies) {
    const to = join(dir, ...m.to.split('/'));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(m.fromDir, ...m.from.split('/')), to);
  }
  const partitions = [...kept, ...added].sort((a, b) => a.n - b.n);
  const result: ManifestV4 = {
    ...manifest,
    formatVersion:
      from !== null && from.manifest.formatVersion > manifest.formatVersion
        ? from.manifest.formatVersion
        : manifest.formatVersion,
    updatedAt: o.now,
    complete: true,
    ...totalsAndRange(partitions),
    partitions,
  };
  parseAnyManifest(manifestForWrite(result));
  await writeRunReport(deps, dir, result);
  return {
    written: [...copies.map((m) => m.to), MANIFEST_PATH, 'index.html', '.nojekyll'],
    dropped: dropped.flatMap(filePathsOf),
    next,
  };
}

/** Adds the partitions of the run report at `fromDir` to the one report at `dir` (see `replaceRunPartitions`). */
export async function addRunReport(
  deps: WriterDeps,
  dir: string,
  fromDir: string,
  run: { runId: number; attempt: number },
  o: { now: string; next: number },
): Promise<{ written: string[]; dropped: string[]; next: number }> {
  const manifest = await readRunManifest(deps.fs, fromDir);
  if (manifest === null)
    throw new OtelHtmlError('invalid-report', {
      path: `${fromDir}/${MANIFEST_PATH}`,
      expected: 'a run report',
    });
  return replaceRunPartitions(deps, dir, { dir: fromDir, manifest }, run, o);
}

/** Drops every partition of run `runId` from the one report at `dir`. */
export const removeRun = (
  deps: WriterDeps,
  dir: string,
  runId: number,
  o: { now: string },
): Promise<{ written: string[]; dropped: string[]; next: number }> =>
  replaceRunPartitions(deps, dir, null, { runId, attempt: 0 }, { ...o, next: 0 });
