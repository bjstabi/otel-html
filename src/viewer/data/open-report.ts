import { type AnyManifest, isV4, type ManifestV4, parseAnyManifest } from '../../format/manifest.js';
import { OtelHtmlError } from '../../model/errors.js';
import { traced } from '../telemetry.js';
import type { DataSource } from './data-source.js';
import { createDuckDbDataSource } from './duckdb-source.js';
import { registerPartitions } from './engine/files.js';
import { type Engine, type EngineDeps, startEngine } from './engine/start.js';
import { createCoordinator, engineConnector, type Logger, mosaicQueryEngine } from './mosaic.js';
import { tracedDataSource } from './traced.js';

/** Where `load` is: starting the engine, registering partition `done` of `total`, creating the views. */
export interface LoadProgress {
  phase: 'engine' | 'partitions' | 'views';
  done?: number;
  total?: number;
}

export interface OpenDeps extends EngineDeps {
  logger: Logger;
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
export function openReport(
  rawManifest: unknown,
  deps: OpenDeps,
  onProgress: (p: LoadProgress) => void,
): Promise<DataSource> {
  const manifest = requireFormat4(parseAnyManifest(rawManifest));
  const attrs = {
    'otel_html.format': manifest.engine.format,
    'otel_html.partitions': manifest.partitions.length,
    'otel_html.bytes': partitionBytes(manifest),
  };
  return traced(
    'viewer.load',
    { 'otel_html.report.version': manifest.otelHtmlVersion, ...attrs },
    async () => {
      onProgress({ phase: 'engine' });
      const engine: Engine = await traced('viewer.engine.start', attrs, () =>
        startEngine(manifest.engine, deps),
      );
      try {
        const total = manifest.partitions.reduce((n, p) => n + Object.keys(p.files).length, 0);
        onProgress({ phase: 'partitions', done: 0, total });
        await traced('viewer.partitions.register', attrs, () =>
          registerPartitions(engine, manifest, deps, ({ done, total }) =>
            onProgress(done < total ? { phase: 'partitions', done, total } : { phase: 'views' }),
          ),
        );
        const queryEngine = mosaicQueryEngine(
          createCoordinator(engineConnector(engine.connection), deps.logger),
          engine,
        );
        return tracedDataSource(
          createDuckDbDataSource({ engine: queryEngine, manifest, logger: deps.logger }),
        );
      } catch (error) {
        await engine.close().catch(() => undefined);
        throw error;
      }
    },
  );
}
