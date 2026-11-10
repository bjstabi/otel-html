import { type ManifestV4, parseAnyManifest } from '../../format/manifest.js';
import { MANIFEST_KEY, MANIFEST_PATH } from '../../format/paths.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { DataSource } from './data-source.js';
import { createDuckDbDataSource } from './duckdb-source.js';
import { createViews, dropFiles, manifestFiles, registerFiles } from './engine/files.js';
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
}

/**
 * D55: loads `data/manifest.js?r=<now>` through the loader (which resolves with the registered `manifest`), validates it
 * (format 4), registers the files the new manifest lists and the old did not, drops the ones gone, recreates the views,
 * clears the engine cache and returns a DataSource over the new manifest and the same engine. A manifest that does
 * not validate rejects before anything is registered or dropped.
 */
export async function refreshReport(
  engine: Engine,
  queryEngine: QueryEngine,
  previous: ManifestV4,
  deps: RefreshDeps,
  now: () => number,
): Promise<{ dataSource: DataSource; manifest: ManifestV4 }> {
  const raw = await deps.loader.load(`${MANIFEST_PATH}?r=${now()}`, MANIFEST_KEY);
  const manifest = requireFormat4(parseAnyManifest(raw));

  const had = new Set(manifestFiles(previous).map((f) => f.path));
  const wanted = manifestFiles(manifest);
  const wantedPaths = new Set(wanted.map((f) => f.path));
  await registerFiles(
    engine,
    wanted.filter((f) => !had.has(f.path)),
    deps,
  );
  await createViews(engine, manifest);
  // Last and best-effort: the views no longer read these files, so a failed drop only leaks a registration.
  for (const path of had) {
    if (wantedPaths.has(path)) continue;
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
