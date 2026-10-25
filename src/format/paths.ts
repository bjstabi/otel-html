import { OtelHtmlError } from '../model/errors.js';
import type { TraceId } from '../model/ids.js';

export const SIGNALS = ['spans', 'logs', 'metrics'] as const;
export type Signal = (typeof SIGNALS)[number];

export const MANIFEST_PATH = 'data/manifest.js';
export const STATE_DIR = 'data/state';
export const LOCK_PATH = 'data/state/lock.json';

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
