import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PartitionFile } from '../../format/manifest.js';
import { PartitionFileSchema, SOURCE_RE } from '../../format/manifest.js';
import type { Table } from '../../format/parquet/columns.js';
import { TABLES } from '../../format/parquet/columns.js';
import { parseWith } from '../../format/validate.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { FileSystem } from '../../writer/ports.js';
import type { JobId } from './ids.js';

export const UPDATE_PREFIX = 'otel-html-update-';
export const UPDATE_FILE = 'update.json';
type UpdateKind = 'push' | 'run' | 'remove-pr' | 'reopen-pr';

/** One partition the update lists: its site `source`, its manifest entry's files (paths update-relative: `partitions/<i>/<table>.parquet`), and whether this update carries those files. */
export interface UpdatePartition {
  source: string;
  files: Partial<Record<Table, PartitionFile>>;
  carried: boolean;
}

export interface UpdateJson {
  version: 1;
  kind: UpdateKind;
  runId: number;
  runAttempt: number;
  createdAt: string;
  jobId?: number | string;
  jobName?: string;
  sequence?: number;
  partitions?: UpdatePartition[];
  ci?: UpdatePartition;
  pr?: number;
}

const nonNegInt = z.number().int().nonnegative();
const posInt = z.number().int().positive();

const partitionShape = {
  source: z.string().regex(SOURCE_RE, 'a source like job:7#compact:3'),
  files: z.strictObject({
    spans: z.exactOptional(PartitionFileSchema),
    logs: z.exactOptional(PartitionFileSchema),
    points: z.exactOptional(PartitionFileSchema),
    traces: z.exactOptional(PartitionFileSchema),
    patterns: z.exactOptional(PartitionFileSchema),
  }),
};
const UpdatePartitionSchema: z.ZodType<UpdatePartition> = z.strictObject({
  ...partitionShape,
  carried: z.boolean(),
});
/** The job's `ci` partition is always carried by the update that lists it. */
const CiPartitionSchema: z.ZodType<UpdatePartition> = z.strictObject({
  ...partitionShape,
  carried: z.literal(true),
});

const REQUIRED: Record<UpdateKind, readonly (keyof UpdateJson)[]> = {
  push: ['jobId', 'jobName', 'sequence', 'partitions'],
  run: [],
  'remove-pr': ['pr'],
  'reopen-pr': ['pr'],
};
const OPTIONAL_FIELDS = ['jobId', 'jobName', 'sequence', 'partitions', 'ci', 'pr'] as const;

export const UpdateJsonSchema: z.ZodType<UpdateJson> = z
  .strictObject({
    version: z.literal(1),
    kind: z.enum(['push', 'run', 'remove-pr', 'reopen-pr']),
    runId: nonNegInt,
    runAttempt: posInt,
    createdAt: z.iso.datetime(),
    jobId: z.exactOptional(z.union([nonNegInt, z.string()])),
    jobName: z.exactOptional(z.string()),
    sequence: z.exactOptional(posInt),
    partitions: z.exactOptional(z.array(UpdatePartitionSchema)),
    ci: z.exactOptional(CiPartitionSchema),
    pr: z.exactOptional(nonNegInt),
  })
  .superRefine((u, ctx) => {
    const allowed = new Set<string>([...REQUIRED[u.kind], ...(u.kind === 'push' ? ['ci'] : [])]);
    for (const f of OPTIONAL_FIELDS) {
      const present = u[f] !== undefined;
      if (present && !allowed.has(f))
        ctx.addIssue({ code: 'custom', path: [f], message: `not allowed in a ${u.kind} update` });
      if (!present && REQUIRED[u.kind].includes(f))
        ctx.addIssue({ code: 'custom', path: [f], message: `required in a ${u.kind} update` });
    }
  });

/** D61: the numeric job id as text, or `h` + 12 hex of sha256 of `<attempt>:<id>` for a string id. */
export function jobSourceKey(jobId: JobId, runAttempt: number): string {
  if (typeof jobId === 'number') return String(jobId);
  return `h${createHash('sha256').update(`${runAttempt}:${jobId}`).digest('hex').slice(0, 12)}`;
}

/** `otel-html-update-push-<job key>-<sequence>`, `-run-<run>-<attempt>`, `-remove-pr-<pr>-<run>`, `-reopen-pr-<pr>-<run>`. */
export function updateName(u: UpdateJson): string {
  switch (u.kind) {
    case 'push':
      return `${UPDATE_PREFIX}push-${jobSourceKey(u.jobId ?? '', u.runAttempt)}-${u.sequence}`;
    case 'run':
      return `${UPDATE_PREFIX}run-${u.runId}-${u.runAttempt}`;
    case 'remove-pr':
    case 'reopen-pr':
      return `${UPDATE_PREFIX}${u.kind}-${u.pr}-${u.runId}`;
  }
}

export type ParsedName =
  | { kind: 'push'; jobKey: string; sequence: number }
  | { kind: 'run'; runId: number; runAttempt: number }
  | { kind: 'remove-pr' | 'reopen-pr'; pr: number; runId: number };

const NAME_RES = {
  push: /^push-(0|[1-9]\d*|h[0-9a-f]{12})-(0|[1-9]\d*)$/,
  run: /^run-(0|[1-9]\d*)-(0|[1-9]\d*)$/,
  pr: /^(remove-pr|reopen-pr)-(0|[1-9]\d*)-(0|[1-9]\d*)$/,
};

/** D59: the facts the deployer trusts come from here. */
export function parseUpdateName(name: string): ParsedName | undefined {
  if (!name.startsWith(UPDATE_PREFIX)) return undefined;
  const rest = name.slice(UPDATE_PREFIX.length);
  const safe = (s: string | undefined): number | undefined => {
    const n = Number(s);
    return s !== undefined && Number.isSafeInteger(n) ? n : undefined;
  };
  const push = NAME_RES.push.exec(rest);
  if (push?.[1] !== undefined) {
    const sequence = safe(push[2]);
    return sequence === undefined ? undefined : { kind: 'push', jobKey: push[1], sequence };
  }
  const run = NAME_RES.run.exec(rest);
  if (run) {
    const runId = safe(run[1]);
    const runAttempt = safe(run[2]);
    return runId === undefined || runAttempt === undefined ? undefined : { kind: 'run', runId, runAttempt };
  }
  const pr = NAME_RES.pr.exec(rest);
  if (pr?.[1] === 'remove-pr' || pr?.[1] === 'reopen-pr') {
    const n = safe(pr[2]);
    const runId = safe(pr[3]);
    return n === undefined || runId === undefined ? undefined : { kind: pr[1], pr: n, runId };
  }
  return undefined;
}

/**
 * The name's facts and the json's agree, per kind. `push`: the job key equals `jobSourceKey(jobId, runAttempt)` and the
 * sequence matches; a push name carries no run id, so run and (for a numeric key) attempt are NOT checked here and the
 * deployer must compare the push's `runId` with the artifact's `workflow_run.id` itself. `run`: run id and attempt.
 * `remove-pr`/`reopen-pr`: pr and run id.
 */
export function nameMatches(parsed: ParsedName, u: UpdateJson): boolean {
  if (parsed.kind !== u.kind) return false;
  switch (parsed.kind) {
    case 'push':
      return (
        u.jobId !== undefined &&
        parsed.jobKey === jobSourceKey(u.jobId, u.runAttempt) &&
        parsed.sequence === u.sequence
      );
    case 'run':
      return parsed.runId === u.runId && parsed.runAttempt === u.runAttempt;
    case 'remove-pr':
    case 'reopen-pr':
      return parsed.pr === u.pr && parsed.runId === u.runId;
  }
}

export const MAX_UPDATE_BYTES: number = 256 * 1024 * 1024;

const TABLE_ALT = TABLES.join('|');
const LAYOUT: Record<UpdateKind, RegExp> = {
  push: new RegExp(`^(update\\.json|partitions/\\d+/(${TABLE_ALT})\\.parquet|ci/(${TABLE_ALT})\\.parquet)$`),
  run: new RegExp(
    `^(update\\.json|report/index\\.html|report/\\.nojekyll|report/data/manifest\\.js|report/data/partitions/[0-9]{6}/(${TABLE_ALT})\\.parquet)$`,
  ),
  'remove-pr': /^update\.json$/,
  'reopen-pr': /^update\.json$/,
};

const bad = (path: string, expected: string, actual?: string): OtelHtmlError =>
  new OtelHtmlError('invalid-report', actual === undefined ? { path, expected } : { path, expected, actual });

async function sizeOf(fs: FileSystem, p: string): Promise<number> {
  return fs.openBlob ? (await fs.openBlob(p)).size : (await fs.readBytes(p)).byteLength;
}

/** Every file under `dir` as a relative `/` path; anything but a plain file or folder is rejected. */
async function walk(fs: FileSystem, dir: string, rel: string, out: string[]): Promise<void> {
  const here = rel === '' ? dir : `${dir}/${rel}`;
  for (const name of await fs.list(here)) {
    const r = rel === '' ? name : `${rel}/${name}`;
    const kind = await fs.entryKind(`${dir}/${r}`);
    if (kind === 'dir') await walk(fs, dir, r, out);
    else if (kind === 'file') out.push(r);
    else throw bad(r, 'a plain file or folder', kind);
  }
}

function carriedFiles(u: UpdateJson): Map<string, PartitionFile> {
  const out = new Map<string, PartitionFile>();
  (u.partitions ?? []).forEach((p, i) => {
    if (!p.carried) return;
    for (const t of TABLES) {
      const f = p.files[t];
      if (f) out.set(`partitions/${i}/${t}.parquet`, f);
    }
  });
  if (u.ci) {
    for (const t of TABLES) {
      const f = u.ci.files[t];
      if (f) out.set(`ci/${t}.parquet`, f);
    }
  }
  return out;
}

/** A push lists only its own job's sources: `job:<key>#…` partitions and `ci:<key>`. */
function checkSources(u: UpdateJson, key: string): void {
  for (const p of u.partitions ?? [])
    if (!p.source.startsWith(`job:${key}#`))
      throw bad(UPDATE_FILE, `a source starting with job:${key}#`, p.source);
  if (u.ci && u.ci.source !== `ci:${key}`) throw bad(UPDATE_FILE, `the source ci:${key}`, u.ci.source);
}

/** Reads and validates `<dir>/update.json`, then walks the whole tree: every entry is a plain file or folder (`entryKind`), every file a layout path of the update's kind (Global Constraints), carried partitions' files exist and match `bytes`, the total is at most MAX_UPDATE_BYTES. Failures are `invalid-report` naming the path. */
export async function readUpdate(fs: FileSystem, dir: string): Promise<UpdateJson> {
  const jsonKind = await fs.entryKind(`${dir}/${UPDATE_FILE}`);
  if (jsonKind !== 'file') throw bad(UPDATE_FILE, 'a plain file', jsonKind);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readText(`${dir}/${UPDATE_FILE}`));
  } catch {
    throw bad(UPDATE_FILE, 'JSON');
  }
  const u = parseWith(UpdateJsonSchema, raw, UPDATE_FILE);
  if (u.kind === 'push' && u.jobId !== undefined) checkSources(u, jobSourceKey(u.jobId, u.runAttempt));

  const files: string[] = [];
  await walk(fs, dir, '', files);
  const layout = LAYOUT[u.kind];
  let total = 0;
  const sizes = new Map<string, number>();
  for (const f of files) {
    if (!layout.test(f)) throw bad(f, `a ${u.kind} update layout path`);
    const size = await sizeOf(fs, `${dir}/${f}`);
    sizes.set(f, size);
    total += size;
    if (total > MAX_UPDATE_BYTES) throw bad(f, `an update of at most ${MAX_UPDATE_BYTES} bytes`);
  }
  for (const [path, file] of carriedFiles(u)) {
    if (file.path !== path) throw bad(path, `a manifest path of ${path}`, file.path);
    const size = sizes.get(path);
    if (size === undefined) throw bad(path, 'a carried partition file that exists');
    if (size !== file.bytes) throw bad(path, `${file.bytes} bytes`, `${size} bytes`);
  }
  return u;
}
