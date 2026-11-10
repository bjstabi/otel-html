import type { ResolvedConfig } from '../../config/schema.js';
import { reviveDataJson, unwrapDataFile, wrapDataFile } from '../../format/data-file.js';
import { ENGINE_VERSION } from '../../format/engine.js';
import {
  isV4,
  type ManifestV4,
  type PartitionEntry,
  type PartitionFile,
  parseAnyManifest,
} from '../../format/manifest.js';
import { TABLES, type Table } from '../../format/parquet/columns.js';
import { statisticsKeysFor } from '../../format/parquet/stats.js';
import { MANIFEST_KEY, MANIFEST_PATH, partitionFilePath } from '../../format/paths.js';
import { PARTITION_FORMAT_VERSION } from '../../format/version.js';
import { OtelHtmlError } from '../../model/errors.js';
import { renderIndexHtml } from '../../writer/html.js';
import type { FileSystem } from '../../writer/ports.js';
import type { WriterDeps } from '../../writer/session.js';
import type { UpdateJson, UpdatePartition } from './update.js';

/** D53: the deployer's bookkeeping for one run report (`site-state/runs.json` entry). */
export interface RunReportState {
  next: number;
  attempt: number;
  jobs: Record<string, { name: string; attempt: number; sequence: number; sources: string[] }>;
}

export const emptyRunState = (attempt: number): RunReportState => ({ next: 0, attempt, jobs: {} });

export interface NewManifestOptions {
  title: string;
  epochUnixNano: string;
  createdAt: string;
  assetsBase: string;
  config: ResolvedConfig;
  version: string;
}

/** An empty, `complete: false` v4 manifest in `site` format with `statisticsKeysFor` each table from `config`. */
export function newRunManifest(o: NewManifestOptions): ManifestV4 {
  const statisticsKeys = Object.fromEntries(TABLES.map((t) => [t, statisticsKeysFor(t, o.config)])) as Record<
    Table,
    string[]
  >;
  return {
    formatVersion: PARTITION_FORMAT_VERSION,
    otelHtmlVersion: o.version,
    title: o.title,
    epochUnixNano: o.epochUnixNano,
    createdAt: o.createdAt,
    updatedAt: o.createdAt,
    complete: false,
    range: null,
    totals: { spans: 0, logs: 0, metrics: 0 },
    partitions: [],
    statisticsKeys,
    engine: { version: ENGINE_VERSION, format: 'site', assetsBase: o.assetsBase },
    config: {
      viewer: {
        ...o.config.viewer,
        facetValueCap: o.config.writer.facetValueCap,
        facetKeyCap: o.config.writer.facetKeyCap,
      },
      dashboards: o.config.dashboards,
      views: o.config.views,
    },
  };
}

/** One unpacked push update of the job. */
export interface JobUpdate {
  dir: string;
  update: UpdateJson;
}

export interface SyncInput {
  manifest: ManifestV4;
  state: RunReportState;
  jobKey: string;
  jobName: string;
  attempt: number;
  /** This job's pending updates, any order. */
  updates: readonly JobUpdate[];
  /** The new `updatedAt`. */
  now: string;
}

/** Copy `<fromDir>/<from>` (update-relative) to `<site>/<run>/<to>`. */
export interface FileMove {
  fromDir: string;
  from: string;
  to: string;
}

export interface SyncPlan {
  manifest: ManifestV4;
  state: RunReportState;
  copies: FileMove[];
  /** Site-relative (run-relative) paths of the files the new manifest no longer lists. */
  drops: string[];
  pending: boolean;
  /** Why the plan is what it is: `applied` (copies, drops or a new manifest), `unchanged` (already applied or nothing to apply), `stale` (a lower attempt than this job name's), `pending` (a carrier is missing). */
  outcome: 'applied' | 'unchanged' | 'stale' | 'pending';
}

const filePaths = (e: PartitionEntry): string[] => TABLES.flatMap((t) => e.files[t]?.path ?? []);

/** The partition files as the manifest lists them: numbered `n`, values normalised to the manifest's keys. */
function entryFrom(
  n: number,
  p: UpdatePartition,
  dir: string,
  keys: Record<Table, string[]>,
  copies: FileMove[],
): PartitionEntry {
  const files: PartitionEntry['files'] = {};
  for (const t of TABLES) {
    const f = p.files[t];
    if (f === undefined) continue;
    const values: PartitionFile['values'] = {};
    for (const k of keys[t]) values[k] = f.values[k] ?? null;
    const to = partitionFilePath(n, t);
    files[t] = { ...f, path: to, values };
    copies.push({ fromDir: dir, from: f.path, to });
  }
  return { n, source: p.source, files };
}

function totalsAndRange(partitions: readonly PartitionEntry[]): Pick<ManifestV4, 'totals' | 'range'> {
  const totals = { spans: 0, logs: 0, metrics: 0 };
  let start: bigint | null = null;
  let end: bigint | null = null;
  for (const e of partitions) {
    totals.spans += e.files.spans?.rows ?? 0;
    totals.logs += e.files.logs?.rows ?? 0;
    totals.metrics += e.files.points?.rows ?? 0;
    for (const t of TABLES) {
      const f = e.files[t];
      if (f?.timeMin != null && (start === null || BigInt(f.timeMin) < start)) start = BigInt(f.timeMin);
      if (f?.timeMax != null && (end === null || BigInt(f.timeMax) > end)) end = BigInt(f.timeMax);
    }
  }
  return {
    totals,
    range: start === null || end === null ? null : { start: start.toString(), end: end.toString() },
  };
}

/**
 * §5.1 as a pure function. Every `JobUpdate` must have passed `readUpdate` and `nameMatches`, and all belong to the
 * one job `jobKey`. The listing is the highest-sequence update's `partitions` plus its `ci`; sequences at or below
 * `state.jobs[jobKey].sequence` are ignored (`unchanged`). The attempt gate is per job name: an update whose
 * `attempt` is below the highest attempt recorded for any job entry of the same `jobName` is `stale` (`pending:
 * false`, no change); a higher attempt drops the sources of those older same-named entries and resets `complete`.
 * Other names are never gated. `state.attempt` is the run-level maximum. The state is not trusted over the manifest:
 * `next` is at least one past the highest `n` in the manifest, and the job's previous sources are the state's plus
 * every manifest source `job:<jobKey>#…` or `ci:<jobKey>`. A listed partition's files come from the manifest (same
 * `source`), else from any update that carries them; when neither has one, `pending: true` and nothing else changes.
 * The job's `ci` partition is the one exception: a `ci` the top update carries replaces the manifest's. New partitions
 * take numbers from `next` upward; their `values` are normalised to the manifest's `statisticsKeys`; the job's
 * partitions whose `source` is no longer listed, and a replaced `ci`, are dropped (`drops`: their paths). Totals and
 * range are recomputed; `complete` is false; `updatedAt` is `now`.
 */
export function planSync(input: SyncInput): SyncPlan {
  const { manifest, jobKey, jobName, attempt } = input;
  const none = (outcome: 'unchanged' | 'stale' | 'pending'): SyncPlan => ({
    manifest,
    state: input.state,
    copies: [],
    drops: [],
    pending: outcome === 'pending',
    outcome,
  });
  const ordered = [...input.updates].sort((a, b) => (b.update.sequence ?? 0) - (a.update.sequence ?? 0));
  const top = ordered[0];
  if (top === undefined) return none('unchanged');

  const sameName = Object.entries(input.state.jobs).filter(([, j]) => j.name === jobName);
  if (sameName.some(([, j]) => attempt < j.attempt)) return none('stale');

  // A newer attempt: the older entries of the same name are being rerun, so their sources go.
  const jobs: RunReportState['jobs'] = {};
  const dropSources = new Set<string>();
  const rerunSources = new Set<string>();
  for (const [k, j] of Object.entries(input.state.jobs)) {
    if (j.name === jobName && j.attempt < attempt)
      for (const s of j.sources) {
        dropSources.add(s);
        rerunSources.add(s);
      }
    else jobs[k] = j;
  }
  const sequence = top.update.sequence ?? 0;
  const previous = jobs[jobKey];
  if (previous !== undefined && sequence <= previous.sequence) return none('unchanged');
  for (const s of previous?.sources ?? []) dropSources.add(s);
  for (const e of manifest.partitions)
    if (e.source.startsWith(`job:${jobKey}#`) || e.source === `ci:${jobKey}`) dropSources.add(e.source);

  const listing = (u: UpdateJson): { p: UpdatePartition; isCi: boolean }[] => [
    ...(u.partitions ?? []).map((p) => ({ p, isCi: false })),
    ...(u.ci === undefined ? [] : [{ p: u.ci, isCi: true }]),
  ];
  const bySource = new Map(manifest.partitions.map((e) => [e.source, e]));
  const kept = new Set<string>();
  const copies: FileMove[] = [];
  const added: PartitionEntry[] = [];
  let next = Math.max(input.state.next, ...manifest.partitions.map((e) => e.n + 1));
  for (const { p, isCi } of listing(top.update)) {
    // Sources of reruns being dropped are not "in the manifest" for this job any more.
    const inManifest = bySource.has(p.source) && !rerunSources.has(p.source);
    if (inManifest && !(isCi && p.carried)) {
      kept.add(p.source);
      continue;
    }
    const carrier = p.carried
      ? { dir: top.dir, p }
      : ordered
          .slice(1)
          .flatMap((u) => listing(u.update).map((l) => ({ dir: u.dir, p: l.p })))
          .find((c) => c.p.source === p.source && c.p.carried);
    if (carrier === undefined) return none('pending');
    added.push(entryFrom(next++, carrier.p, carrier.dir, manifest.statisticsKeys, copies));
  }

  const dropped = manifest.partitions.filter((e) => dropSources.has(e.source) && !kept.has(e.source));
  const partitions = [...manifest.partitions.filter((e) => !dropped.includes(e)), ...added].sort(
    (a, b) => a.n - b.n,
  );
  const sources = listing(top.update).map((l) => l.p.source);
  const result: ManifestV4 = {
    ...manifest,
    updatedAt: input.now,
    complete: false,
    ...totalsAndRange(partitions),
    partitions,
  };
  parseAnyManifest(result);
  return {
    manifest: result,
    state: {
      next,
      attempt: Math.max(input.state.attempt, attempt),
      jobs: { ...jobs, [jobKey]: { name: jobName, attempt, sequence, sources } },
    },
    copies,
    drops: dropped.flatMap(filePaths),
    pending: false,
    outcome: 'applied',
  };
}

/**
 * The manifest with partitions renumbered from `from` (ascending, paths rewritten) and the file moves that realise it
 * (D54). The moves are ordered so that applying them one after the other in one directory is safe: partitions that
 * shift up move last-first (descending `n`), those that shift down first-first (ascending), and a partition that
 * keeps its number has no move.
 */
export function renumbered(
  manifest: ManifestV4,
  from: number,
): { manifest: ManifestV4; moves: { from: string; to: string }[] } {
  const up: { from: string; to: string }[] = [];
  const down: { from: string; to: string }[] = [];
  const partitions = manifest.partitions.map((e, i): PartitionEntry => {
    const n = from + i;
    const files: PartitionEntry['files'] = {};
    for (const t of TABLES) {
      const f = e.files[t];
      if (f === undefined) continue;
      const to = partitionFilePath(n, t);
      if (n > e.n) up.push({ from: f.path, to });
      else if (n < e.n) down.push({ from: f.path, to });
      files[t] = { ...f, path: to };
    }
    return { ...e, n, files };
  });
  const result = { ...manifest, partitions };
  parseAnyManifest(result);
  return { manifest: result, moves: [...down, ...up.reverse()] };
}

/** Writes `data/manifest.js`, `index.html` (no host meta) and `.nojekyll` into `dir`. */
export async function writeRunReport(
  deps: Pick<WriterDeps, 'fs' | 'viewerAssets'>,
  dir: string,
  manifest: ManifestV4,
): Promise<void> {
  await deps.fs.mkdirp(`${dir}/data`);
  await deps.fs.writeTextAtomic(`${dir}/${MANIFEST_PATH}`, wrapDataFile(MANIFEST_KEY, manifest));
  await deps.fs.writeTextAtomic(
    `${dir}/index.html`,
    renderIndexHtml(deps.viewerAssets.entry(), manifest.title, { assetsBase: manifest.engine.assetsBase }),
  );
  await deps.fs.writeTextAtomic(`${dir}/.nojekyll`, '');
}

/** `null` when `data/manifest.js` is absent. */
export async function readRunManifest(fs: FileSystem, dir: string): Promise<ManifestV4 | null> {
  const path = `${dir}/${MANIFEST_PATH}`;
  if (!(await fs.exists(path))) return null;
  const m = parseAnyManifest(reviveDataJson(unwrapDataFile(await fs.readText(path), MANIFEST_KEY)));
  if (!isV4(m)) throw new OtelHtmlError('invalid-report', { path, expected: 'a format 4 manifest' });
  return m;
}
