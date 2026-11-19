import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResolvedReport, sessionOf } from '../../api/report.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { TABLE_COLUMNS } from '../../format/parquet/columns.js';
import {
  type DecodedShared,
  type ResultRow,
  SharedInterner,
  sharedFromRow,
  spanFromRow,
} from '../../format/parquet/decode.js';
import { readColumns } from '../../format/parquet/stream.js';
import type { UnixNanos } from '../../model/ids.js';
import type { SpanRecord } from '../../model/records.js';
// The CLI reads Parquet here and nothing else on its import path registers the codec's WASM.
import '../../writer/parquet-wasm-source.js';
import type { WriterDeps } from '../../writer/session.js';
import { replaceRunPartitions, runSourcePrefix } from './main-report.js';
import { readRunManifest } from './run-report.js';

/** The scope of the spans the CI dashboard reads: the workflow, job and queued spans the deployer writes. */
export const CI_SCOPE = 'otel-html-ci';

const TIME_COLUMNS = ['start_time_unix_nano', 'end_time_unix_nano'] as const;
const SHARED_COLUMNS = [
  'resource_attributes',
  'resource_schema_url',
  'resource_dropped_attributes_count',
  'scope_name',
  'scope_version',
  'scope_attributes',
  'scope_schema_url',
  'scope_dropped_attributes_count',
] as const;

/**
 * Replaces run `run.runId`'s partitions in the one report at `dir` by one that keeps only the spans of scope
 * `CI_SCOPE` (no logs, no points), written through a scratch report. Nothing is deleted from `dir`: `dropped` lists
 * the old partitions' files. A run with no partition changes nothing.
 */
export async function trimRun(
  deps: WriterDeps,
  dir: string,
  run: { runId: number; attempt: number },
  config: ResolvedConfig,
  o: { now: string; next: number },
): Promise<{ written: string[]; dropped: string[]; next: number }> {
  const manifest = await readRunManifest(deps.fs, dir);
  const prefix = runSourcePrefix(run.runId);
  const entries = manifest?.partitions.filter((e) => e.source.startsWith(prefix)) ?? [];
  if (entries.length === 0) return { written: [], dropped: [], next: o.next };
  const scratch = await mkdtemp(join(tmpdir(), 'trim-run-'));
  try {
    const report = await createResolvedReport({ out: scratch, replace: true }, config, deps);
    const session = sessionOf(report);
    const interner = new SharedInterner();
    const names = TABLE_COLUMNS.spans.map((c) => c.name);
    for (const entry of entries) {
      const file = entry.files.spans;
      if (file === undefined || file.timeMin == null) continue;
      const epoch = BigInt(file.timeMin);
      const path = `${dir}/${file.path}`;
      const blob = deps.fs.openBlob?.(path) ?? new Blob([new Uint8Array(await deps.fs.readBytes(path))]);
      for await (const cols of readColumns('spans', await blob, path)) {
        const n = cols[0]?.length ?? 0;
        const memo = new Map<string, DecodedShared>();
        const sharedOf = (r: ResultRow): DecodedShared => {
          const k = JSON.stringify(SHARED_COLUMNS.map((c) => (r[c] === null ? null : String(r[c]))));
          let v = memo.get(k);
          if (v === undefined) {
            v = sharedFromRow(r);
            memo.set(k, v);
          }
          return v;
        };
        const rows: SpanRecord[] = [];
        for (let i = 0; i < n; i++) {
          const row: Record<string, unknown> = {};
          for (const [c, name] of names.entries()) row[name] = cols[c]?.[i] ?? null;
          if (Reflect.get(row, 'scope_name') !== CI_SCOPE) continue;
          for (const c of TIME_COLUMNS) {
            const v = row[c];
            if (typeof v === 'bigint') row[c] = v - epoch;
          }
          const { span, shared } = spanFromRow(row, epoch, sharedOf);
          rows.push({
            ...span,
            resource: interner.resource(shared.resource),
            scope: interner.scope(shared.scope),
          });
        }
        if (rows.length === 0) continue;
        await session.addRecords({
          signal: 'spans',
          rows,
          resources: interner.resources,
          scopes: interner.scopes,
          epoch: epoch as UnixNanos,
        });
      }
    }
    await report.close();
    const slim = await readRunManifest(deps.fs, scratch);
    if (slim === null) return replaceRunPartitions(deps, dir, null, run, o);
    return await replaceRunPartitions(deps, dir, { dir: scratch, manifest: slim }, run, o);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
