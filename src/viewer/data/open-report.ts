import { type AnyManifest, isV4, type ManifestV4, parseAnyManifest } from '../../format/manifest.js';
import { OtelHtmlError } from '../../model/errors.js';
import { traced } from '../telemetry.js';
import type { DataSource } from './data-source.js';
import { createDuckDbDataSource } from './duckdb-source.js';
import { registerPartitions } from './engine/files.js';
import { type Engine, type EngineDeps, startEngine } from './engine/start.js';
import { createCoordinator, engineConnector, type Logger, mosaicQueryEngine } from './mosaic.js';
import type { QueryEngine } from './query-engine.js';
import { tracedDataSource } from './traced.js';

/** Where `load` is: starting the engine, registering partition `done` of `total`, creating the views. */
export interface LoadProgress {
  phase: 'engine' | 'partitions' | 'views';
  done?: number;
  total?: number;
}

/** The collaborators `openReport` composes; tests replace them. */
export interface OpenParts {
  startEngine: typeof startEngine;
  registerPartitions: typeof registerPartitions;
  /** The query engine over a started engine (a Mosaic coordinator in production). */
  createQueryEngine: (engine: Engine, logger: Logger) => QueryEngine;
  createSource: typeof createDuckDbDataSource;
}

export interface OpenDeps extends EngineDeps {
  logger: Logger;
  parts?: Partial<OpenParts>;
}

const realParts: OpenParts = {
  startEngine,
  registerPartitions,
  createQueryEngine: (engine, logger) =>
    mosaicQueryEngine(createCoordinator(engineConnector(engine.connection), logger), engine),
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

/** The D12 gate: the viewer reads format 4 only. */
export function requireFormat4(manifest: AnyManifest): ManifestV4 {
  if (isV4(manifest)) return manifest;
  throw new OtelHtmlError('invalid-report', {
    message: `This report is format ${manifest.formatVersion}; this viewer reads format 4. \`otel-html merge <report> --out <new>\` converts it.`,
  });
}

const partitionBytes = (m: ManifestV4): number =>
  m.partitions.reduce((n, p) => n + Object.values(p.files).reduce((k, f) => k + f.bytes, 0), 0);

/**
 * The composition root's load: validate the manifest, start the engine, register the partitions (which creates the
 * views), and build the traced format-4 data source. `viewer.load` carries the `viewer.engine.start` and
 * `viewer.partitions.register` spans as children.
 */
export async function openReport(
  rawManifest: unknown,
  deps: OpenDeps,
  onProgress: (p: LoadProgress) => void,
): Promise<DataSource> {
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
        const queryEngine = parts.createQueryEngine(engine, deps.logger);
        return tracedDataSource(parts.createSource({ engine: queryEngine, manifest, logger: deps.logger }));
      } catch (error) {
        await engine.close().catch((closeError: unknown) => {
          deps.logger.warn('could not close the engine after a failed load', closeError);
        });
        throw error;
      }
    },
  );
}
