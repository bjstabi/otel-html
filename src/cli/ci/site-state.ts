import { z } from 'zod';
import type { FileSystem } from '../../writer/ports.js';
import type { RunReportState } from './run-report.js';

export const SITE_STATE_DIR: string = 'site-state';
/** D65: `otel-html-site-state-<run id>` (full) or `otel-html-site-state-base-<deployment id>` (consumed-only). */
export const STATE_PREFIX: string = 'otel-html-site-state-';
export const DELETION_GRACE_MS: number = 15 * 60_000;
const HOUR_MS = 3_600_000;
/** What a missing or malformed file reads as: dated at the epoch, so nothing is newer than it. */
const EPOCH = new Date(0).toISOString();

export type StateForm = { kind: 'full'; runId: number } | { kind: 'consumed'; base: number };

export function stateArtifactName(form: StateForm): string {
  return form.kind === 'full' ? `${STATE_PREFIX}${form.runId}` : `${STATE_PREFIX}base-${form.base}`;
}

export function parseStateName(name: string): StateForm | undefined {
  const m = /^otel-html-site-state-(base-)?(\d+)$/.exec(name);
  if (m === null) return undefined;
  const n = Number(m[2]);
  return m[1] === undefined ? { kind: 'full', runId: n } : { kind: 'consumed', base: n };
}

export type UpdateOutcome = 'applied' | 'superseded' | 'removed-pr' | 'complete' | 'rejected';

export interface AppliedJson {
  version: 1;
  form: StateForm;
  /** Consumed update artifact ids with their outcome, the artifact's `created_at` and the deployer run (`pass`) that consumed them; entries whose `createdAt` is older than `floor` are dropped on write. */
  updates: Record<string, { outcome: UpdateOutcome; createdAt: string; pass: number }>;
  /** The creation-time floor for the next listing: the oldest still-pending update's `created_at` (or this pass's start) minus one hour. */
  floor: string;
  writtenAt: string;
}
export interface RemovedJson {
  version: 1;
  prs: Record<string, { runId: number; at: string }>;
}
/** Every site path and its size. */
export interface FilesJson {
  version: 1;
  files: Record<string, number>;
}
/** `pass`: the deployer run that dropped the file. */
export interface DeletionsJson {
  version: 1;
  files: { path: string; pass: number; liveAt?: string }[];
}
/** By run report path. */
export interface RunsJson {
  version: 1;
  runs: Record<string, RunReportState>;
}
export interface SiteState {
  applied: AppliedJson;
  removed: RemovedJson;
  files: FilesJson;
  deletions: DeletionsJson;
  runs: RunsJson;
}

const count = z.number().int().nonnegative();
const AppliedSchema: z.ZodType<AppliedJson> = z.strictObject({
  version: z.literal(1),
  form: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('full'), runId: count }),
    z.strictObject({ kind: z.literal('consumed'), base: count }),
  ]),
  updates: z.record(
    z.string(),
    z.strictObject({
      outcome: z.enum(['applied', 'superseded', 'removed-pr', 'complete', 'rejected']),
      createdAt: z.string(),
      pass: count,
    }),
  ),
  floor: z.string(),
  writtenAt: z.string(),
});
const RemovedSchema: z.ZodType<RemovedJson> = z.strictObject({
  version: z.literal(1),
  prs: z.record(z.string(), z.strictObject({ runId: count, at: z.string() })),
});
const FilesSchema: z.ZodType<FilesJson> = z.strictObject({
  version: z.literal(1),
  files: z.record(z.string(), count),
});
const DeletionsSchema: z.ZodType<DeletionsJson> = z.strictObject({
  version: z.literal(1),
  files: z.array(z.strictObject({ path: z.string(), pass: count, liveAt: z.exactOptional(z.string()) })),
});
const RunReportStateSchema: z.ZodType<RunReportState> = z.strictObject({
  next: count,
  attempt: count,
  jobs: z.record(
    z.string(),
    z.strictObject({
      name: z.string(),
      attempt: count,
      sequence: count,
      sources: z.array(z.string()),
    }),
  ),
});
const RunsSchema: z.ZodType<RunsJson> = z.strictObject({
  version: z.literal(1),
  runs: z.record(z.string(), RunReportStateSchema),
});

export function emptyState(now: string): SiteState {
  return {
    applied: {
      version: 1,
      form: { kind: 'full', runId: 0 },
      updates: {},
      floor: new Date(Date.parse(now) - HOUR_MS).toISOString(),
      writtenAt: now,
    },
    removed: { version: 1, prs: {} },
    files: { version: 1, files: {} },
    deletions: { version: 1, files: [] },
    runs: { version: 1, runs: {} },
  };
}

const FILES = ['applied', 'removed', 'deletions', 'runs', 'files'] as const;
const SCHEMAS = {
  applied: AppliedSchema,
  removed: RemovedSchema,
  deletions: DeletionsSchema,
  runs: RunsSchema,
  files: FilesSchema,
} as const;

/** `dir` is the `site-state` directory itself. A missing file is its empty form; a malformed one warns and is empty. */
export async function readSiteState(
  fs: FileSystem,
  dir: string,
  warn: (m: string) => void,
): Promise<SiteState> {
  const state = emptyState(EPOCH);
  for (const name of FILES) {
    const path = `${dir}/${name}.json`;
    if (!(await fs.exists(path))) continue;
    try {
      const parsed = SCHEMAS[name].safeParse(JSON.parse(await fs.readText(path)));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid');
      Object.assign(state, { [name]: parsed.data });
    } catch (e) {
      warn(`${path}: ignored, reading it as empty (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return state;
}

/** Atomic per file, `files.json` last; `applied.updates` older than `floor` are dropped. */
export async function writeSiteState(fs: FileSystem, dir: string, state: SiteState): Promise<void> {
  const floor = Date.parse(state.applied.floor);
  const updates = Object.fromEntries(
    Object.entries(state.applied.updates).filter(([, u]) => !(Date.parse(u.createdAt) < floor)),
  );
  const out: SiteState = { ...state, applied: { ...state.applied, updates } };
  await fs.mkdirp(dir);
  for (const name of FILES) await fs.writeTextAtomic(`${dir}/${name}.json`, `${JSON.stringify(out[name])}\n`);
}

/** Walks `site` (skipping `site-state/`) into `FilesJson`. */
export async function scanFiles(fs: FileSystem, site: string): Promise<FilesJson> {
  const files: Record<string, number> = {};
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of (await fs.list(abs)).sort()) {
      const r = rel === '' ? name : `${rel}/${name}`;
      if (r === SITE_STATE_DIR) continue;
      const p = `${abs}/${name}`;
      const kind = await fs.entryKind(p);
      if (kind === 'dir') await walk(p, r);
      else if (kind === 'file')
        files[r] = fs.openBlob ? (await fs.openBlob(p)).size : (await fs.readBytes(p)).length;
    }
  };
  await walk(site, '');
  return { version: 1, files };
}
