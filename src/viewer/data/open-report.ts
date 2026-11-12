import { type ManifestV4, parseAnyManifest } from '../../format/manifest.js';
import { traced } from '../telemetry.js';
import type { DataSource } from './data-source.js';
import { createDuckDbDataSource } from './duckdb-source.js';
import { registerPartitions, swapToBuffer } from './engine/files.js';
import { smallFiles } from './engine/small-files.js';
import { type Engine, type EngineDeps, startEngine } from './engine/start.js';
import {
  createCoordinator,
  engineConnector,
  type Logger,
  mosaicQueryEngine,
  restQueryEngine,
} from './mosaic.js';
import type { QueryEngine } from './query-engine.js';
import { refreshReport } from './refresh-report.js';
import { requireFormat4 } from './require-format4.js';
import { tracedDataSource } from './traced.js';

export { requireFormat4 };

/** Where `load` is: connecting to the host, starting the engine, registering partition `done` of `total`, creating the views. */
export interface LoadProgress {
  phase: 'engine' | 'partitions' | 'views' | 'host';
  done?: number;
  total?: number;
}

/** The collaborators `openReport` composes; tests replace them. */
export interface OpenParts {
  startEngine: typeof startEngine;
  registerPartitions: typeof registerPartitions;
  /** The query engine over a started engine (a Mosaic coordinator in production). */
  createQueryEngine: (
    engine: Engine,
    logger: Logger,
    prepare?: (paths: readonly string[], signal?: AbortSignal) => Promise<void>,
  ) => QueryEngine;
  /** The query engine over a host's REST endpoint (D43). */
  createRestEngine: (endpoint: string, logger: Logger) => QueryEngine;
  createSource: typeof createDuckDbDataSource;
}

/** What `openReportRefreshable` returns: the data source and, for a report with an engine in the page, its Refresh. */
export interface OpenedReport {
  dataSource: DataSource;
  /**
   * D55: re-reads the manifest and returns a data source over the same engine. Null on a served report (#246).
   * With an unchanged manifest it returns the data source already shown, unless `rerun` (a reader's click, spec 5.7):
   * then it clears the result cache and returns a fresh data source over the same manifest, so pages re-run their queries.
   */
  refresh: ((rerun?: boolean) => Promise<DataSource>) | null;
}

export interface OpenDeps extends EngineDeps {
  logger: Logger;
  /** The clock `refresh` stamps `?r=` with. */
  now?: () => number;
  /** The `otel-html-host` meta tag's content (an endpoint relative to `baseUrl`), or null when the report is a file. */
  host?: string | null;
  parts?: Partial<OpenParts>;
}

const realParts: OpenParts = {
  startEngine,
  registerPartitions,
  createQueryEngine: (engine, logger, prepare) =>
    mosaicQueryEngine(
      createCoordinator(engineConnector(engine.connection, engine.gate), logger),
      engine,
      true,
      undefined,
      prepare,
    ),
  createRestEngine: (endpoint, logger) => restQueryEngine(endpoint, logger),
  createSource: createDuckDbDataSource,
};

/** Partitions fully registered once `files` files are, with files registered in manifest order (zero-file ones count at once). */
function partitionsDone(counts: readonly number[], files: number): number {
  let seen = 0;
  let done = 0;
  for (const c of counts) {
    seen += c;
    if (seen > files) break;
    done += 1;
  }
  return done;
}

const partitionBytes = (m: ManifestV4): number =>
  m.partitions.reduce((n, p) => n + Object.values(p.files).reduce((k, f) => k + f.bytes, 0), 0);

/**
 * The composition root's load: validate the manifest, start the engine, register the partitions (which creates the
 * views), and build the traced format-4 data source. `viewer.load` carries the `viewer.engine.start` and
 * `viewer.partitions.register` spans as children. With `deps.host` set it starts no engine and registers nothing: the
 * host has the views, so the data source queries its REST endpoint.
 */
export async function openReport(
  rawManifest: unknown,
  deps: OpenDeps,
  onProgress: (p: LoadProgress) => void,
): Promise<DataSource> {
  return (await openReportRefreshable(rawManifest, deps, onProgress)).dataSource;
}

/**
 * `openReport` plus the report's Refresh (D55). `refresh` keeps the engine and the query engine the load built, and
 * the manifest of the last refresh as the next one's `previous`; calls are serialised. It is null with `deps.host`
 * set: the host serves one manifest.
 */
export async function openReportRefreshable(
  rawManifest: unknown,
  deps: OpenDeps,
  onProgress: (p: LoadProgress) => void,
): Promise<OpenedReport> {
  const parts: OpenParts = { ...realParts, ...deps.parts };
  const manifest = requireFormat4(parseAnyManifest(rawManifest));
  const attrs = {
    'otel_html.format': manifest.engine.format,
    'otel_html.partitions': manifest.partitions.length,
    'otel_html.bytes': partitionBytes(manifest),
  };
  const fileCounts = manifest.partitions.map((p) => Object.keys(p.files).length);
  const total = manifest.partitions.length;
  return traced(
    'viewer.load',
    { 'otel_html.report.version': manifest.otelHtmlVersion, ...attrs },
    async () => {
      if (deps.host !== undefined && deps.host !== null) {
        onProgress({ phase: 'host' });
        const queryEngine = parts.createRestEngine(new URL(deps.host, deps.baseUrl).href, deps.logger);
        const dataSource = tracedDataSource(
          parts.createSource({ engine: queryEngine, manifest, logger: deps.logger }),
        );
        return { dataSource, refresh: null };
      }
      onProgress({ phase: 'engine' });
      const engine: Engine = await traced('viewer.engine.start', attrs, () =>
        parts.startEngine(manifest.engine, deps),
      );
      try {
        onProgress({ phase: 'partitions', done: 0, total });
        await traced('viewer.partitions.register', attrs, () =>
          parts.registerPartitions(engine, manifest, deps, (f) =>
            onProgress(
              f.done < f.total
                ? { phase: 'partitions', done: partitionsDone(fileCounts, f.done), total }
                : { phase: 'views' },
            ),
          ),
        );
        let current = manifest;
        const sizes = new Map<string, number>();
        const fillSizes = (m: ManifestV4): void => {
          for (const p of m.partitions) for (const f of Object.values(p.files)) sizes.set(f.path, f.bytes);
        };
        fillSizes(manifest);
        // only a site report registers by URL; a local one already holds every file as a buffer
        const small =
          engine.format === 'site'
            ? smallFiles({
                bytesOf: (path) => sizes.get(path),
                fetchWhole: async (path) => {
                  const response = await fetch(new URL(path, deps.baseUrl).href);
                  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
                  return new Uint8Array(await response.arrayBuffer());
                },
                swap: (path, bytes) => swapToBuffer(engine, path, bytes, new URL(path, deps.baseUrl).href),
              })
            : undefined;
        const queryEngine = parts.createQueryEngine(
          engine,
          deps.logger,
          small ? (paths, signal) => small.prepare(paths, signal) : undefined,
        );
        const dataSource = tracedDataSource(
          parts.createSource({ engine: queryEngine, manifest, logger: deps.logger }),
        );
        let shown = dataSource;
        let last: Promise<unknown> = Promise.resolve();
        const refresh = (rerun = false): Promise<DataSource> => {
          const run = last.then(async () => {
            const next = await refreshReport(
              engine,
              queryEngine,
              current,
              {
                loader: deps.loader,
                baseUrl: deps.baseUrl,
                logger: deps.logger,
                ...(small ? { smallFiles: small } : {}),
              },
              deps.now ?? Date.now,
            );
            current = next.manifest;
            fillSizes(current);
            if (next.dataSource !== null) shown = next.dataSource;
            else if (rerun) {
              queryEngine.clearCache();
              shown = tracedDataSource(
                parts.createSource({ engine: queryEngine, manifest: current, logger: deps.logger }),
              );
            }
            return shown;
          });
          last = run.catch(() => undefined);
          return run;
        };
        return { dataSource, refresh };
      } catch (error) {
        await engine.close().catch((closeError: unknown) => {
          deps.logger.warn('could not close the engine after a failed load', closeError);
        });
        throw error;
      }
    },
  );
}
