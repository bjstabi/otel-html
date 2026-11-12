import { type ManifestV4, parseAnyManifest } from '../../format/manifest.js';
import { MANIFEST_KEY, MANIFEST_PATH } from '../../format/paths.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { DataSource } from './data-source.js';
import { createDuckDbDataSource } from './duckdb-source.js';
import { createViews, dropFiles, manifestFiles, registerFiles } from './engine/files.js';
import type { SmallFiles } from './engine/small-files.js';
import type { Engine } from './engine/start.js';
import type { Logger } from './mosaic.js';
import type { QueryEngine } from './query-engine.js';
import { requireFormat4 } from './require-format4.js';
import type { ScriptLoader } from './script-loader.js';
import { tracedDataSource } from './traced.js';

export interface RefreshDeps {
  loader: ScriptLoader;
  baseUrl: string;
  logger: Logger;
  /** A site report's small-file loader: told which paths the refresh dropped. */
  smallFiles?: Pick<SmallFiles, 'forget'>;
}

/**
 * D55: loads `data/manifest.js?r=<now>` through the loader (which resolves with the registered `manifest`), validates it
 * (format 4), registers the files the new manifest lists and the old did not, drops the ones gone, recreates the views,
 * clears the engine cache and returns a DataSource over the new manifest and the same engine. A manifest that does
 * not validate rejects before anything is registered or dropped; one with the same `updatedAt` and files as `previous`
 * changes nothing and returns a null `dataSource`. A failure while registering or creating views restores the previous
 * views, drops what this refresh registered and rethrows.
 */
export async function refreshReport(
  engine: Engine,
  queryEngine: QueryEngine,
  previous: ManifestV4,
  deps: RefreshDeps,
  now: () => number,
): Promise<{ dataSource: DataSource | null; manifest: ManifestV4 }> {
  const raw = await deps.loader.load(`${MANIFEST_PATH}?r=${now()}`, MANIFEST_KEY);
  const manifest = requireFormat4(parseAnyManifest(raw));

  const had = new Set(manifestFiles(previous).map((f) => f.path));
  const wanted = manifestFiles(manifest);
  const wantedPaths = new Set(wanted.map((f) => f.path));
  // Nothing new was published: keep the shown data source, so no view is recreated, no cache cleared, no page re-queried.
  if (
    manifest.updatedAt === previous.updatedAt &&
    had.size === wantedPaths.size &&
    [...had].every((path) => wantedPaths.has(path))
  ) {
    return { dataSource: null, manifest: previous };
  }
  const added = wanted.filter((f) => !had.has(f.path));
  // A kept path whose size changed was rewritten in place: a buffer swapped in earlier is stale, so it is registered by URL again.
  const sizeOf = (m: ManifestV4): Map<string, number> =>
    new Map(
      m.partitions.flatMap((p) => Object.values(p.files).map((file) => [file.path, file.bytes] as const)),
    );
  const oldSizes = sizeOf(previous);
  const newSizes = sizeOf(manifest);
  const rewritten = wanted.filter((f) => had.has(f.path) && oldSizes.get(f.path) !== newSizes.get(f.path));
  try {
    // No statement runs between the drop and the registration of a rewritten path.
    const reregister = async (): Promise<void> => {
      for (const { path } of rewritten) {
        deps.smallFiles?.forget([path]);
        await dropFiles(engine, [path]);
      }
      await registerFiles(engine, rewritten, deps);
    };
    if (rewritten.length > 0) await (engine.gate ? engine.gate.hold(reregister) : reregister());
    await registerFiles(engine, added, deps);
    await createViews(engine, manifest);
  } catch (error) {
    await rollBack(engine, previous, added, deps.logger, deps.smallFiles);
    throw error;
  }
  // Last and best-effort: the views no longer read these files, so a failed drop only leaks a registration.
  for (const path of had) {
    if (wantedPaths.has(path)) continue;
    deps.smallFiles?.forget([path]);
    await dropFiles(engine, [path]).catch((error: unknown) => {
      deps.logger.warn(`could not drop ${path} after a refresh`, error);
    });
  }
  queryEngine.clearCache();
  const dataSource = tracedDataSource(
    createDuckDbDataSource({ engine: queryEngine, manifest, logger: deps.logger }),
  );
  return { dataSource, manifest };
}

/**
 * Best effort after a refresh failed part-way: the views of the manifest the page still shows, and the files this
 * refresh registered dropped. A rollback that fails too is logged; the caller rethrows the original error.
 */
async function rollBack(
  engine: Engine,
  previous: ManifestV4,
  added: ReturnType<typeof manifestFiles>,
  logger: Logger,
  small?: Pick<SmallFiles, 'forget'>,
): Promise<void> {
  try {
    await createViews(engine, previous);
  } catch (error) {
    logger.error('could not restore the previous views after a failed refresh', error);
  }
  for (const { path } of added) {
    small?.forget([path]);
    await dropFiles(engine, [path]).catch((error: unknown) => {
      logger.error(`could not drop ${path} after a failed refresh`, error);
    });
  }
}

/**
 * The engine's wordings for a registered file that cannot be opened. Chromium (measured in `e2e/refresh.spec.ts`)
 * says "Opening file '<path>' failed with error: Failed to open file: <path>" on the first read and then
 * 'No files found that match the pattern "<path>"' on every query after it, with no status and no "HTTP"; the first
 * branch is the wording a native HTTP filesystem gives (unverified in Firefox and WebKit).
 */
const GONE_FILE =
  /HTTP[^\n]*\b404\b|\b404\b[^\n]*Not Found|Opening file '[^'\n]*' failed with error: Failed to open file|No files found that match the pattern/i;

/**
 * A query failure caused by a registered file the site no longer serves (D56): the browser engine's message for a
 * file it cannot open (a 404), matched on the wording of `GONE_FILE` so a binder "not found" or an HTTP 500 does not count. The text looked
 * at is the engine's own (`actual` of the `OtelHtmlError` the query engine wraps it in), never the SQL (`hint`).
 */
export function isGoneFile(error: unknown): boolean {
  const text =
    error instanceof OtelHtmlError ? (error.actual ?? '') : error instanceof Error ? error.message : '';
  return GONE_FILE.test(text);
}
