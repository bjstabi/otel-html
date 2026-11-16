import '../../src/writer/parquet-wasm-source.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PartitionEntry } from '../../src/format/manifest.js';
import { decodeTable, encodeTable, type LayoutOptions } from '../../src/format/parquet/codec.js';
import { TABLES } from '../../src/format/parquet/columns.js';
import { logRef, parseLogRef, refParts } from '../../src/viewer/data/log-query.js';
import { writeReportDir } from '../report-dir.js';
import type { ScalingReport } from './generator.js';

const get = (row: Record<string, unknown> | undefined, key: string): unknown => row?.[key];

/**
 * The same rows as `base` in another layout (`mise run measure:layout`): every file but the patterns is decoded and
 * encoded again with `layout`, in a new report folder. The manifest keeps its rows and statistics; only `bytes` change.
 * The log ref of the ids follows its row: the log of the base report's ref is found again by its time, service and body.
 */
export async function relayoutReport(
  base: ScalingReport,
  layout: LayoutOptions,
  rowGroupRows: number,
): Promise<ScalingReport> {
  const files = new Map<string, Uint8Array>();
  const partitions: PartitionEntry[] = [];
  let ids = base.ids;
  for (const partition of base.manifest.partitions) {
    const out: PartitionEntry = { ...partition, files: {} };
    for (const table of TABLES) {
      const file = partition.files[table];
      if (file === undefined) continue;
      const bytes = new Uint8Array(await readFile(join(base.dir, file.path)));
      const rewritten =
        table !== 'patterns'
          ? encodeTable(table, decodeTable(table, bytes), { rowGroupRows, layout })
          : bytes;
      files.set(file.path, rewritten);
      out.files[table] = { ...file, bytes: rewritten.length };
    }
    partitions.push(out);
  }
  // the log of the base ref, in the new file
  const { n, i } = refParts(parseLogRef(base.ids.logRef, 'relayout.logRef'));
  const entry = base.manifest.partitions.find((p) => p.n === n);
  const logs = entry?.files.logs;
  if (logs !== undefined) {
    const before = decodeTable('logs', new Uint8Array(await readFile(join(base.dir, logs.path))))[i];
    const bytes = files.get(logs.path);
    if (before !== undefined && bytes !== undefined) {
      const after = decodeTable('logs', bytes);
      const at = after.findIndex(
        (r) =>
          get(r, 'time_unix_nano') === get(before, 'time_unix_nano') &&
          get(r, 'service_name') === get(before, 'service_name') &&
          get(r, 'scope_name') === get(before, 'scope_name') &&
          get(r, 'body') === get(before, 'body'),
      );
      if (at < 0) throw new Error('the log of the ref is not in the rewritten file');
      ids = { ...ids, logRef: logRef(n, at) };
    }
  }
  const manifest = { ...base.manifest, partitions };
  const written = await writeReportDir({ manifest, files, epoch: base.epoch });
  return { ...base, dir: written.dir, manifest, ids, close: written.close };
}
