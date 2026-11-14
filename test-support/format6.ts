import { readFile, writeFile } from 'node:fs/promises';
import {
  Table as ArrowTable,
  tableFromIPC,
  tableToIPC,
  Utf8,
  type Vector,
  vectorFromArray,
} from 'apache-arrow';
import { readParquet, Table as WasmTable, writeParquet } from 'parquet-wasm/esm';
import { wrapDataFile } from '../src/format/data-file.js';
import {
  isPartitioned,
  type ManifestV4,
  manifestAnchor,
  manifestForWrite,
  parseAnyManifest,
} from '../src/format/manifest.js';
import { writerProperties } from '../src/format/parquet/codec.js';
import { SERVICE_SHARE_COLUMN, TABLES } from '../src/format/parquet/columns.js';
import { ensureParquetWasm } from '../src/format/parquet/wasm.js';
import { MANIFEST_KEY } from '../src/format/paths.js';
import { encodeServiceShare, type ShareSpan, serviceShareOf } from '../src/format/service-share.js';
import type { Format4Fixture } from './format4-fixture.js';
import { writeReportDir } from './report-dir.js';

const PROVISIONAL = 'otel_html.ci.provisional';

interface Cell {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  start_time_unix_nano: bigint | number;
  end_time_unix_nano: bigint | number;
  service_name: string | null;
  attributes: unknown;
}

function readRows(bytes: Uint8Array): Cell[] {
  ensureParquetWasm();
  const arrow = tableFromIPC(readParquet(bytes).intoIPCStream());
  return arrow.toArray().map((r) => (r as { toJSON(): Cell }).toJSON());
}

function provisional(attributes: unknown): boolean {
  if (typeof attributes !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(attributes);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>)[PROVISIONAL] === true
    );
  } catch {
    return false;
  }
}

/** The stored share of each trace of a partition, from its spans (`serviceShareOf`; times relative to the trace's earliest start). */
function sharesOf(spans: readonly Cell[]): Map<string, string> {
  const byTrace = new Map<string, Cell[]>();
  for (const s of spans) {
    const id = s.trace_id;
    byTrace.set(id, [...(byTrace.get(id) ?? []), s]);
  }
  const out = new Map<string, string>();
  for (const [id, rows] of byTrace) {
    const starts = rows.map((r) => BigInt(r.start_time_unix_nano));
    let origin = starts[0] ?? 0n;
    for (const t of starts) if (t < origin) origin = t;
    const shareSpans = rows.map((r, i): ShareSpan => {
      const start = Number((starts[i] ?? origin) - origin);
      const end = Number(BigInt(r.end_time_unix_nano) - origin);
      return {
        spanId: r.span_id,
        parentId: r.parent_span_id ?? null,
        service: r.service_name ?? 'unknown',
        start,
        end,
        durationNs: Math.max(0, end - start),
        provisional: provisional(r.attributes),
      };
    });
    out.set(id, encodeServiceShare(serviceShareOf(shareSpans)));
  }
  return out;
}

/**
 * The test stand-in for the format-6 writer: rewrites the traces file of each partition of the report folder `dir`
 * (all of them, or those numbered in `only`) with a `service_share` column computed from its spans file, lists
 * `serviceShare: true`, and returns (and writes to `data/manifest.js`) the manifest as format 6 without an epoch.
 * The Parquet bytes are the file's own Arrow table plus one utf8 column, written with the repository's properties,
 * so the codec's table schemas stay as they are.
 */
export async function withServiceShare(
  dir: string,
  manifest: ManifestV4,
  only?: readonly number[],
): Promise<ManifestV4> {
  ensureParquetWasm();
  const partitions = [];
  for (const entry of manifest.partitions) {
    const { spans, traces } = entry.files;
    if (traces === undefined || spans === undefined || (only !== undefined && !only.includes(entry.n))) {
      partitions.push(entry);
      continue;
    }
    const shares = sharesOf(readRows(await readFile(`${dir}/${spans.path}`)));
    const arrow = tableFromIPC(readParquet(await readFile(`${dir}/${traces.path}`)).intoIPCStream());
    const column = arrow.getChild('trace_id');
    const cells = Array.from({ length: arrow.numRows }, (_, i) => shares.get(String(column?.get(i))) ?? null);
    const named = Object.fromEntries(arrow.schema.fields.map((f) => [f.name, arrow.getChild(f.name)]));
    const withColumn = new ArrowTable({
      ...(named as Record<string, Vector>),
      [SERVICE_SHARE_COLUMN.name]: vectorFromArray(cells, new Utf8()),
    });
    const bytes = writeParquet(
      WasmTable.fromIPCStream(tableToIPC(withColumn, 'stream')),
      writerProperties({ rowGroupRows: 1000 }),
    );
    await writeFile(`${dir}/${traces.path}`, bytes);
    partitions.push({
      ...entry,
      files: { ...entry.files, traces: { ...traces, bytes: bytes.length, serviceShare: true as const } },
    });
  }
  const written = manifestForWrite({ ...manifest, formatVersion: 6, partitions });
  await writeFile(`${dir}/data/manifest.js`, wrapDataFile(MANIFEST_KEY, written));
  // What a reader gets: the format-6 parse fills the anchor (`range.start`, else `createdAt`), whatever epoch `manifest` had.
  const out = parseAnyManifest(JSON.parse(JSON.stringify(written)));
  if (!isPartitioned(out)) throw new Error('a format-6 manifest parses as a partition manifest');
  return out;
}

/**
 * `f` as a format-6 fixture: its report folder written, `withServiceShare` applied to the partitions numbered in `only`
 * (all when absent), the files read back. `close` removes the folder.
 */
export async function format6Fixture(
  f: Format4Fixture,
  only?: readonly number[],
): Promise<Format4Fixture & { dir: string; close(): Promise<void> }> {
  const report = await writeReportDir(f);
  const manifest = await withServiceShare(report.dir, f.manifest, only);
  const files = new Map<string, Uint8Array>();
  for (const entry of manifest.partitions) {
    for (const table of TABLES) {
      const file = entry.files[table];
      if (file !== undefined) files.set(file.path, await readFile(`${report.dir}/${file.path}`));
    }
  }
  return { manifest, files, epoch: manifestAnchor(manifest), dir: report.dir, close: report.close };
}
