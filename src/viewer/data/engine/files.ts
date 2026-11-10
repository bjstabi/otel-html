import { DuckDBDataProtocol } from '@duckdb/duckdb-wasm';
import type { ManifestV4 } from '../../../format/manifest.js';
import type { Table } from '../../../format/parquet/columns.js';
import { partitionKey, partitionWrapperPath } from '../../../format/paths.js';
import { viewStatements } from '../../../query/sql/views.js';
import { fromBase64, loadText } from './bytes.js';
import type { Engine, EngineDeps } from './start.js';

export interface RegisterProgress {
  done: number;
  total: number;
}

const LOCAL_CONCURRENCY = 4;

export interface FileEntry {
  n: number;
  table: Table;
  /** The manifest path (`data/partitions/<p6>/<table>.parquet`), the name the file is registered under. */
  path: string;
}

/** The files a manifest lists, in manifest order. */
export function manifestFiles(manifest: ManifestV4): FileEntry[] {
  return manifest.partitions.flatMap((partition) =>
    Object.entries(partition.files).map(([table, file]) => ({
      n: partition.n,
      table: table as Table,
      path: file.path,
    })),
  );
}

/**
 * Registers `entries` under their manifest paths. site: by URL with range reads; local: from the base64 wrappers,
 * four loads in flight at a time. `onProgress` after each file (once with 0 of 0 when there are none).
 */
export async function registerFiles(
  engine: Engine,
  entries: readonly FileEntry[],
  deps: Pick<EngineDeps, 'loader' | 'baseUrl'>,
  onProgress?: (p: RegisterProgress) => void,
): Promise<void> {
  const total = entries.length;
  let done = 0;
  const finish = (): void => {
    done += 1;
    onProgress?.({ done, total });
  };

  if (total === 0) onProgress?.({ done: 0, total: 0 });

  if (engine.format === 'site') {
    for (const { path } of entries) {
      await engine.db.registerFileURL(path, new URL(path, deps.baseUrl).href, DuckDBDataProtocol.HTTP, false);
      finish();
    }
  } else {
    let next = 0;
    let failed = false;
    const worker = async (): Promise<void> => {
      while (!failed && next < entries.length) {
        const entry = entries[next++];
        if (entry === undefined) return;
        try {
          const url = new URL(partitionWrapperPath(entry.n, entry.table), deps.baseUrl).href;
          // The base64 string is local to this call: only the registered bytes outlive it.
          const bytes = fromBase64(await loadText(deps.loader, url, partitionKey(entry.n, entry.table)));
          await engine.db.registerFileBuffer(entry.path, bytes);
          finish();
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOCAL_CONCURRENCY, total) }, worker));
  }
}

/** Forgets the files registered under `paths` (the engine releases a URL file or a buffer). */
export async function dropFiles(engine: Engine, paths: readonly string[]): Promise<void> {
  for (const path of paths) await engine.db.dropFile(path);
}

/** (Re)creates the views over the manifest's files: `viewStatements(manifest, (p) => p)`. */
export async function createViews(engine: Engine, manifest: ManifestV4): Promise<void> {
  for (const statement of viewStatements(manifest, (p) => p)) await engine.connection.query(statement);
}

/** Registers every file the manifest lists, then creates the views. */
export async function registerPartitions(
  engine: Engine,
  manifest: ManifestV4,
  deps: Pick<EngineDeps, 'loader' | 'baseUrl'>,
  onProgress?: (p: RegisterProgress) => void,
): Promise<void> {
  await registerFiles(engine, manifestFiles(manifest), deps, onProgress);
  await createViews(engine, manifest);
}
