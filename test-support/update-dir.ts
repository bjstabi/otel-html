import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UpdateJson } from '../src/cli/ci/update.js';

/** Writes an unpacked update at `dir`: its `update.json` and `files` (update-relative path to bytes). */
export function writeUpdateDir(
  dir: string,
  update: UpdateJson,
  files: Record<string, Uint8Array | string> = {},
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'update.json'), JSON.stringify(update));
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
}

/** A `push` update's folder: `update.json` and the carried partition files (`partitions/<i>/<table>.parquet`, `ci/<table>.parquet`). */
export function writePushUpdate(dir: string, update: UpdateJson, files: Record<string, Uint8Array>): void {
  writeUpdateDir(dir, update, files);
}
