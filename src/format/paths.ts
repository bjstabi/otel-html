import { OtelHtmlError } from '../model/errors.js';
import type { TraceId } from '../model/ids.js';
import type { Table } from './parquet/schema.js';

export const SIGNALS = ['spans', 'logs', 'metrics'] as const;
export type Signal = (typeof SIGNALS)[number];

export const MANIFEST_PATH = 'data/manifest.js';
export const STATE_DIR = 'data/state';
export const LOCK_PATH = 'data/state/lock.json';

/**
 * Session checkpoints alternate between two slots so that a flush interrupted before the manifest commit
 * never destroys the last checkpoint that matches the committed manifest.
 */
export const STATE_SLOTS = [0, 1] as const;
export type StateSlot = (typeof STATE_SLOTS)[number];

export function statePath(slot: StateSlot): string {
  return `${STATE_DIR}/session.${slot}.json`;
}

/** Registration keys: what each data file passes as the first argument of `__OH__.push`. */
export const MANIFEST_KEY = 'manifest';

export function chunkPath(signal: Signal, n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new OtelHtmlError('invalid-report', {
      path: 'chunkPath',
      expected: 'a non-negative integer chunk number',
      actual: String(n),
    });
  }
  return `data/chunks/${signal}/${String(n).padStart(6, '0')}.js`;
}

export function chunkKey(signal: Signal, n: number): string {
  return chunkPath(signal, n).slice('data/'.length, -'.js'.length);
}

export function traceShardPath(shard: string): string {
  return `data/traces/${shard}.js`;
}

export function traceShardKey(shard: string): string {
  return `traces/${shard}`;
}

export function rollupPath(name: string): string {
  return `data/rollups/${name}.js`;
}

export function rollupKey(name: string): string {
  return `rollups/${name}`;
}

/** The trace-index shard a trace belongs to: the first two hex characters of its id. */
export function shardOf(traceId: TraceId): string {
  return traceId.slice(0, 2);
}

export function partitionDir(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new OtelHtmlError('invalid-report', {
      path: 'partitionDir',
      expected: 'a non-negative integer partition number',
      actual: String(n),
    });
  }
  return `data/partitions/${String(n).padStart(6, '0')}`;
}

export function partitionFilePath(n: number, table: Table): string {
  return `${partitionDir(n)}/${table}.parquet`;
}

/** The base64 script next to a Parquet file in the local format. */
export function partitionWrapperPath(n: number, table: Table): string {
  return `${partitionFilePath(n, table)}.js`;
}

export function partitionKey(n: number, table: Table): string {
  return `${partitionDir(n).slice('data/'.length)}/${table}`;
}

/** A manifest-listed partition file: six digits minimum, wider for n >= 10^6. */
export const PARTITION_FILE_RE: RegExp =
  /^data\/partitions\/[0-9]{6,}\/(?:spans|logs|points|traces|patterns)\.parquet$/;

/** A DuckDB engine file under `assets/`, named by engine version. */
export const ENGINE_ASSET_RE: RegExp =
  /^assets\/duckdb\.[0-9][A-Za-z0-9.-]*\.(?:wasm|worker\.js|wasm\.gz\.b64\.js|worker\.b64\.js)$/;
