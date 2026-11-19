import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TABLE_COLUMNS } from '../../format/parquet/columns.js';
import { readColumns } from '../../format/parquet/stream.js';
import type { WriterDeps } from '../../writer/session.js';
import { runSource } from './main-report.js';
import { readRunManifest, totalsAndRange, writeRunReport } from './run-report.js';
import { IN_PROGRESS, type SiteIndex } from './site.js';

const CICD_NAMES = TABLE_COLUMNS.cicd.map((c) => c.name);
const KIND = CICD_NAMES.indexOf('kind');
const RUN_ID = CICD_NAMES.indexOf('run_id');
const ATTEMPT = CICD_NAMES.indexOf('attempt');

/** The `run_id` and `attempt` of the first `run` row of the cicd file at `path`; `undefined` when it has none. */
async function runRow(
  deps: WriterDeps,
  path: string,
): Promise<{ runId: number; attempt: number | null } | undefined> {
  const blob = deps.fs.openBlob?.(path) ?? new Blob([new Uint8Array(await deps.fs.readBytes(path))]);
  for await (const cols of readColumns('cicd', await blob, path)) {
    for (let i = 0; i < (cols[0]?.length ?? 0); i++) {
      if (cols[KIND]?.[i] !== 'run') continue;
      const id = Number(cols[RUN_ID]?.[i]);
      if (!Number.isInteger(id)) continue;
      const attempt = cols[ATTEMPT]?.[i];
      return { runId: id, attempt: attempt === null || attempt === undefined ? null : Number(attempt) };
    }
  }
  return undefined;
}

const dirsIn = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

/**
 * One-shot, idempotent migration of a site laid out as before the one report: the partitions of the report that are not `run:` (`merge:`, `flush:`)
 * at `<site>/<reportPath>` become `run:<id>#<attempt>` (named by their cicd `run` row; one without a row, or of an
 * unindexed run, is dropped with a warning), every indexed run points at that report with `detail` `full` when it had
 * none, and the per-run and per-pull-request folders are handed to `remove` (a `runs/<id>` folder of an in-progress
 * run is a push staging area and stays). Nothing is deleted here.
 */
export async function migrateToOneReport(o: {
  site: string;
  index: SiteIndex;
  reportPath: string;
  deps: WriterDeps;
  warn: (m: string) => void;
  remove: (site: string, paths: string[]) => Promise<void>;
}): Promise<{ index: SiteIndex; changed: boolean }> {
  let changed = false;
  const indexed = new Map<number, number>();
  for (const ch of Object.values(o.index.channels)) for (const r of ch.runs) indexed.set(r.runId, r.attempt);

  const dir = join(o.site, o.reportPath);
  const manifest = await readRunManifest(o.deps.fs, dir);
  if (manifest?.partitions.some((p) => !p.source.startsWith('run:'))) {
    const dropped: string[] = [];
    const partitions = [];
    for (const p of manifest.partitions) {
      if (p.source.startsWith('run:')) {
        partitions.push(p);
        continue;
      }
      const file = p.files.cicd;
      let row: Awaited<ReturnType<typeof runRow>>;
      try {
        row = file === undefined ? undefined : await runRow(o.deps, join(dir, file.path));
      } catch (e) {
        // retried next pass
        o.warn(
          `keeping partition ${p.n} (${p.source}) of ${o.reportPath}: ${file?.path} is unreadable: ${e instanceof Error ? e.message : String(e)}`,
        );
        partitions.push(p);
        continue;
      }
      const fallback = row === undefined ? undefined : indexed.get(row.runId);
      if (row === undefined || fallback === undefined) {
        o.warn(`dropping partition ${p.n} (${p.source}) of ${o.reportPath}: no indexed run in its cicd file`);
        dropped.push(...Object.values(p.files).map((f) => `${o.reportPath}/${f.path}`));
        continue;
      }
      partitions.push({ ...p, source: runSource(row.runId, row.attempt ?? fallback) });
    }
    if (partitions.some((p, i) => p !== manifest.partitions[i]) || dropped.length > 0) {
      await writeRunReport(o.deps, dir, { ...manifest, partitions, ...totalsAndRange(partitions) });
      if (dropped.length > 0) await o.remove(o.site, dropped);
      changed = true;
    }
  }

  const channels: SiteIndex['channels'] = {};
  for (const [key, ch] of Object.entries(o.index.channels)) {
    let touched = false;
    const runs = ch.runs.map((r) => {
      if (r.reportPath === o.reportPath && r.detail !== undefined) return r;
      touched = true;
      return { ...r, reportPath: o.reportPath, detail: r.detail ?? ('full' as const) };
    });
    if (touched) changed = true;
    channels[key] = touched ? { ...ch, runs } : ch;
  }

  const folders = (await dirsIn(join(o.site, 'pr'))).map((n) => `pr/${n}`);
  for (const [key, ch] of Object.entries(o.index.channels)) {
    if (ch.kind !== 'branch') continue;
    const staging = new Set(ch.runs.filter((r) => r.conclusion === IN_PROGRESS).map((r) => String(r.runId)));
    for (const n of await dirsIn(join(o.site, key, 'runs')))
      if (!staging.has(n)) folders.push(`${key}/runs/${n}`);
  }
  if (folders.length > 0) {
    await o.remove(o.site, folders);
    changed = true;
  }
  return { index: changed ? { ...o.index, channels } : o.index, changed };
}
