import { type ManifestV4, parseAnyManifest } from '../../format/manifest.js';
import { MANIFEST_KEY, MANIFEST_PATH } from '../../format/paths.js';
import type { DataSource } from './data-source.js';
import { createDuckDbDataSource } from './duckdb-source.js';
import { createViews, dropFiles, manifestFiles, registerFiles } from './engine/files.js';
import type { Engine } from './engine/start.js';
import type { Logger } from './mosaic.js';
import type { QueryEngine } from './query-engine.js';
import type { Registry } from './registry.js';
import { requireFormat4 } from './require-format4.js';
import type { ScriptLoader } from './script-loader.js';
import { tracedDataSource } from './traced.js';

export interface RefreshDeps {
  loader: ScriptLoader;
  /** Where the loader's scripts register; the loader takes the payload itself, so `refreshReport` never calls it. */
  registry: Pick<Registry, 'take'>;
  baseUrl: string;
  logger: Logger;
}

/**
 * D55: loads `data/manifest.js?r=<now>` through the loader, takes `manifest` from the registry, validates it (format
 * 4), registers the files the new manifest lists and the old did not, drops the ones gone, recreates the views,
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
  // The loader resolves with the payload it took from the registry, so the registry is not asked again here.
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
  await dropFiles(
    engine,
    [...had].filter((path) => !wantedPaths.has(path)),
  );
  await createViews(engine, manifest);
  queryEngine.clearCache();
  const dataSource = tracedDataSource(
    createDuckDbDataSource({ engine: queryEngine, manifest, logger: deps.logger }),
  );
  return { dataSource, manifest };
}

/**
 * A query failure caused by a registered file the site no longer serves (D56): the browser engine's message for an
 * HTTP 404, matched broadly. The exact wording is measured in Task 5.3's e2e.
 */
export function isGoneFile(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /\b404\b|Not Found|HTTP error/i.test(message);
}
