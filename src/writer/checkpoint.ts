import { reviveDataJson, unwrapDataFile, wrapDataFile } from '../format/data-file.js';
import {
  type AnyManifest,
  isV4,
  type Manifest,
  type ManifestV4,
  parseAnyManifest,
} from '../format/manifest.js';
import {
  LOCK_PATH,
  MANIFEST_KEY,
  MANIFEST_PATH,
  PARTITION_DIR_RE,
  SIGNALS,
  type Signal,
  STATE_DIR,
  STATE_SLOTS,
  type StateSlot,
  statePath,
} from '../format/paths.js';
import { parseAnySessionState, type SessionState, type SessionStateV2 } from '../format/state.js';
import type { TraceShard } from '../format/trace-shard.js';
import { OtelHtmlError } from '../model/errors.js';
import type { FileSystem } from './ports.js';

/** `out` + relative report path, tolerating a trailing slash on `out`. */
export function at(out: string, rel: string): string {
  return `${out.replace(/\/+$/, '')}/${rel}`;
}

export interface Checkpoint {
  manifest: Manifest;
  state: SessionState;
  /** The slot holding `state`; the next checkpoint goes to the other one. */
  slot: StateSlot;
}

export interface PartitionCheckpoint {
  manifest: ManifestV4;
  state: SessionStateV2;
  slot: StateSlot;
}

export async function writeManifest(fs: FileSystem, out: string, manifest: AnyManifest): Promise<void> {
  parseAnyManifest(manifest); // never write a manifest the viewer would reject
  await fs.writeTextAtomic(at(out, MANIFEST_PATH), wrapDataFile(MANIFEST_KEY, manifest));
}

/** The state fields that stay small; `dedupe` and `traceIndex` hold the bulk and are streamed separately. */
export type StateHead = Omit<SessionState, 'dedupe' | 'traceIndex'>;

/**
 * The head fields already stringified (`undefined` where `JSON.stringify` would drop the field). A background
 * checkpoint takes these at prepare time: the rollups and metric streams are live structures that go on changing
 * while the state is written.
 */
export interface StringifiedHead {
  readonly fields: { readonly [K in keyof StateHead]: string | undefined };
}

export function stringifyHead(head: StateHead): StringifiedHead {
  const entries = (Object.keys(head) as (keyof StateHead)[]).map((k) => [k, JSON.stringify(head[k])]);
  return { fields: Object.fromEntries(entries) as StringifiedHead['fields'] };
}

/**
 * Where each head field sits around `dedupe` and `traceIndex` in `SessionState` order (listed in that order). Typed
 * as a record over every head field, so a new `SessionState` field fails to compile until it is placed here.
 */
const HEAD_SIDE = {
  formatVersion: 'before',
  otelHtmlVersion: 'before',
  epochUnixNano: 'before',
  nextChunk: 'before',
  rollups: 'before',
  metricStreams: 'after',
  nextSegment: 'after',
} satisfies Record<keyof StateHead, 'before' | 'after'>;

/**
 * Shard names in the order `JSON.stringify` gives an object keyed by them: canonical integer names ("12", "99")
 * first in numeric order, then the rest in the given order. The state slot has always been written from such an
 * object, and its bytes must not change.
 */
export function jsObjectKeyOrder(names: readonly string[]): string[] {
  return Object.keys(Object.fromEntries(names.map((n) => [n, 0])));
}

/** Dedupe keys stringified per piece. */
const DEDUPE_SLICE = 1000;

/**
 * The bytes of `JSON.stringify(state)` as pieces, so the full string (and a Buffer copy of it) never exists: the
 * state embeds the whole trace index, which is hundreds of megabytes under load. Field order is the
 * `SessionState` order; the head arrives stringified (see `stringifyHead`).
 */
export function* stateSlotPieces(
  head: StringifiedHead,
  dedupe: readonly string[],
  shards: Iterable<[string, Readonly<TraceShard>]>,
): Generator<string> {
  const field = (k: keyof StateHead): string | undefined => {
    const v = head.fields[k];
    return v === undefined ? undefined : `${JSON.stringify(k)}:${v}`; // JSON.stringify drops undefined fields
  };
  const keys = Object.keys(HEAD_SIDE) as (keyof StateHead)[];
  const before = keys.filter((k) => HEAD_SIDE[k] === 'before').map(field);
  const after = keys.filter((k) => HEAD_SIDE[k] === 'after').map(field);
  yield `{${before.filter((f) => f !== undefined).join(',')},"dedupe":[`;
  for (let i = 0; i < dedupe.length; i += DEDUPE_SLICE)
    yield (i > 0 ? ',' : '') + JSON.stringify(dedupe.slice(i, i + DEDUPE_SLICE)).slice(1, -1);
  yield '],"traceIndex":{';
  let first = true;
  for (const [shard, view] of shards) {
    yield `${first ? '' : ','}${JSON.stringify(shard)}:${JSON.stringify(view)}`;
    first = false;
  }
  yield `}${after.map((f) => (f === undefined ? '' : `,${f}`)).join('')}}`;
}

export async function writeStateSlot(
  fs: FileSystem,
  out: string,
  slot: StateSlot,
  head: StringifiedHead,
  dedupe: readonly string[],
  shards: Iterable<[string, Readonly<TraceShard>]>,
): Promise<void> {
  const path = at(out, statePath(slot));
  const pieces = stateSlotPieces(head, dedupe, shards);
  if (fs.writePiecesAtomic !== undefined) await fs.writePiecesAtomic(path, pieces);
  else await fs.writeTextAtomic(path, [...pieces].join(''));
}

/** The format-4 state is small (no rollups, no trace index): one atomic write. */
export async function writeStateSlotV2(
  fs: FileSystem,
  out: string,
  slot: StateSlot,
  state: SessionStateV2,
): Promise<void> {
  const text = JSON.stringify(state);
  parseAnySessionState(JSON.parse(text)); // never write a state the next open would reject
  await fs.writeTextAtomic(at(out, statePath(slot)), text);
}

function chunkCounts(manifest: Manifest): Record<Signal, number> | null {
  const counts: Record<Signal, number> = { spans: 0, logs: 0, metrics: 0 };
  for (const s of SIGNALS) {
    const ns = manifest.chunks.filter((c) => c.signal === s).map((c) => c.n);
    if (ns.some((n, i) => n !== i)) return null; // chunk numbers must run 0..k-1 in order
    counts[s] = ns.length;
  }
  return counts;
}

function consistent(state: SessionState, manifest: Manifest): boolean {
  const counts = chunkCounts(manifest);
  return (
    counts !== null &&
    SIGNALS.every((s) => state.nextChunk[s] === counts[s]) &&
    (state.epochUnixNano ?? '0') === manifest.epochUnixNano
  );
}

function versionMismatch(
  out: string,
  path: string,
  reportVersion: string,
  currentVersion: string,
): OtelHtmlError {
  return new OtelHtmlError('version-mismatch', {
    message: `cannot append: the report at ${out} was written by otel-html ${reportVersion} (this is ${currentVersion})`,
    path,
    hint: `pass --replace (replace: true in the library) to start it over, or combine across versions with \`otel-html merge ${out} <new> -o <dir>\``,
  });
}

async function readManifest(fs: FileSystem, out: string): Promise<AnyManifest> {
  const manifestPath = at(out, MANIFEST_PATH);
  if (!(await fs.exists(manifestPath))) {
    throw new OtelHtmlError('usage', {
      message: `cannot append: no report found at ${out} (missing ${MANIFEST_PATH})`,
      hint: 'the folder holds no report; drop --append to create one',
    });
  }
  return parseAnyManifest(reviveDataJson(unwrapDataFile(await fs.readText(manifestPath), MANIFEST_KEY)));
}

/** Read and parse the state slots, newest-first order is not needed: the caller picks the one `matches` the manifest. */
async function pickState<S extends { otelHtmlVersion: string }>(
  fs: FileSystem,
  out: string,
  version: string,
  accept: (state: unknown) => S | null,
  matches: (state: S) => boolean,
  /** With it, the matching slot of the highest rank wins; without it, the first match. */
  rank?: (state: S) => number,
): Promise<{ state: S; slot: StateSlot }> {
  const problems: string[] = [];
  let best: { state: S; slot: StateSlot } | null = null;
  for (const slot of STATE_SLOTS) {
    const p = statePath(slot);
    if (!(await fs.exists(at(out, p)))) continue;
    let state: S | null;
    try {
      state = accept(JSON.parse(await fs.readText(at(out, p))));
    } catch (e) {
      problems.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (state === null) {
      problems.push(`${p}: written by another report format`);
      continue;
    }
    if (state.otelHtmlVersion !== version) {
      throw versionMismatch(out, `${p} otelHtmlVersion`, state.otelHtmlVersion, version);
    }
    if (matches(state)) {
      if (rank === undefined) return { state, slot };
      if (best === null || rank(state) > rank(best.state)) best = { state, slot };
      continue;
    }
    problems.push(`${p}: does not match the committed manifest`);
  }
  if (best !== null) return best;
  throw new OtelHtmlError('invalid-report', {
    path: 'data/state',
    expected: 'a session checkpoint matching data/manifest.js',
    actual: problems.length === 0 ? 'no checkpoint files' : problems.join('; '),
    hint: 'the report cannot be reopened; use `otel-html merge` to combine it with new data',
  });
}

/**
 * Load the committed manifest and the state checkpoint that matches it. A flush interrupted after the
 * state write but before the manifest commit leaves the previous state in the other slot, which is the one
 * picked. A format-4 report is not this session's to open: it fails `version-mismatch`.
 */
export async function loadCheckpoint(fs: FileSystem, out: string, version: string): Promise<Checkpoint> {
  const manifest = await readManifest(fs, out);
  if (isV4(manifest)) {
    throw new OtelHtmlError('version-mismatch', {
      message: `cannot append: the report at ${out} is format 4 (Parquet partitions); this session writes the chunk format`,
      path: 'manifest.formatVersion',
      hint: 'set writer.format to local or site to append to it',
    });
  }
  if (manifest.otelHtmlVersion !== version) {
    throw versionMismatch(out, 'manifest.otelHtmlVersion', manifest.otelHtmlVersion, version);
  }
  const { state, slot } = await pickState<SessionState>(
    fs,
    out,
    version,
    (raw) => {
      const s = parseAnySessionState(raw);
      return s.formatVersion === 1 ? s : null;
    },
    (s) => consistent(s, manifest),
  );
  return { manifest, state, slot };
}

/**
 * The format-4 counterpart of `loadCheckpoint`. The matching state is the one whose `nextPartition` follows the
 * manifest's last partition (0 with none) and whose epoch equals the manifest's: after a crash between the state
 * write and the manifest commit, the state that ran ahead lists a partition the manifest does not, and the other
 * slot is picked. When both slots match (an append after a close that wrote no data, then a crash), the one with the
 * higher `checkpoint` is the newer. A format 1-3 report fails `version-mismatch`.
 */
export async function loadPartitionCheckpoint(
  fs: FileSystem,
  out: string,
  version: string,
): Promise<PartitionCheckpoint> {
  const manifest = await readManifest(fs, out);
  if (!isV4(manifest)) {
    throw new OtelHtmlError('version-mismatch', {
      message: `cannot append: the report at ${out} is format ${manifest.formatVersion}; writer.format local or site writes format 4`,
      path: 'manifest.formatVersion',
      hint: `use merge to convert: \`otel-html merge ${out} -o <dir>\``,
    });
  }
  if (manifest.otelHtmlVersion !== version) {
    throw versionMismatch(out, 'manifest.otelHtmlVersion', manifest.otelHtmlVersion, version);
  }
  const last = manifest.partitions.at(-1);
  const next = last === undefined ? 0 : last.n + 1;
  const { state, slot } = await pickState<SessionStateV2>(
    fs,
    out,
    version,
    (raw) => {
      const s = parseAnySessionState(raw);
      return s.formatVersion === 2 ? s : null;
    },
    (s) => s.nextPartition === next && (s.epochUnixNano ?? '0') === manifest.epochUnixNano,
    (s) => s.checkpoint,
  );
  return { manifest, state, slot };
}

const DATA_DIRS = [
  'data/chunks/spans',
  'data/chunks/logs',
  'data/chunks/metrics',
  'data/traces',
  'data/rollups',
  'data/state',
] as const;

/** Holds one directory per metric (`data/metrics/<id6>/`). */
const METRICS_DIR = 'data/metrics';
const METRIC_DIR_NAME = /^[0-9]{6}$/;
/** Holds one directory per partition (`data/partitions/<p6>/<table>.parquet`). */
const PARTITIONS_DIR = 'data/partitions';

export async function isReportFolder(fs: FileSystem, out: string): Promise<boolean> {
  // A session that failed before its first checkpoint leaves only the state directory behind.
  return (await fs.exists(at(out, MANIFEST_PATH))) || (await fs.exists(at(out, STATE_DIR)));
}

/** Remove a report's data so a new session can replace it. The manifest goes first, the lock stays. */
export async function wipeReportData(fs: FileSystem, out: string): Promise<void> {
  await fs.remove(at(out, MANIFEST_PATH));
  for (const dir of DATA_DIRS) {
    if (!(await fs.exists(at(out, dir)))) continue;
    for (const name of await fs.list(at(out, dir))) {
      const rel = `${dir}/${name}`;
      if (rel === LOCK_PATH) continue;
      await fs.remove(at(out, rel));
    }
  }
  await removeNested(fs, out, METRICS_DIR, METRIC_DIR_NAME);
  await removeNested(fs, out, PARTITIONS_DIR, PARTITION_DIR_RE);
}

/** Remove the files of the directories under `root` whose names match `dirName`; stray entries are not ours. */
async function removeNested(fs: FileSystem, out: string, root: string, dirName: RegExp): Promise<void> {
  if (!(await fs.exists(at(out, root)))) return;
  for (const dir of await fs.list(at(out, root))) {
    // Only our directories: a stray file here (a `.DS_Store`) is not ours and cannot be listed.
    if (!dirName.test(dir)) continue;
    for (const name of await fs.list(at(out, `${root}/${dir}`))) {
      await fs.remove(at(out, `${root}/${dir}/${name}`));
    }
  }
}
