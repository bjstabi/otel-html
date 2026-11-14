import { reviveDataJson, unwrapDataFile, wrapDataFile } from '../format/data-file.js';
import { type AnyManifest, isPartitioned, type ManifestV4, parseAnyManifest } from '../format/manifest.js';
import {
  LOCK_PATH,
  MANIFEST_KEY,
  MANIFEST_PATH,
  PARTITION_DIR_RE,
  STATE_DIR,
  STATE_SLOTS,
  type StateSlot,
  statePath,
} from '../format/paths.js';
import { parseAnySessionState, type SessionStateV2 } from '../format/state.js';
import { OtelHtmlError } from '../model/errors.js';
import type { FileSystem } from './ports.js';

/** `out` + relative report path, tolerating a trailing slash on `out`. */
export function at(out: string, rel: string): string {
  return `${out.replace(/\/+$/, '')}/${rel}`;
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

/** The format-5 state is small (no rollups, no trace index): one atomic write. */
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
 * Loads the committed format-5 manifest and the state checkpoint that matches it. The matching state is the one whose `nextPartition` follows the
 * manifest's last partition (0 with none) and whose epoch equals the manifest's: after a crash between the state
 * write and the manifest commit, the state that ran ahead lists a partition the manifest does not, and the other
 * slot is picked. When both slots match (an append after a close that wrote no data, then a crash), the one with the
 * higher `checkpoint` is the newer. A format 1-3 report fails `version-mismatch`.
 */
export async function loadPartitionCheckpoint(
  fs: FileSystem,
  out: string,
  version: string,
  /** The format the caller writes: the merge hint names it. */
  format: string,
): Promise<PartitionCheckpoint> {
  const manifest = await readManifest(fs, out);
  if (!isPartitioned(manifest)) {
    throw new OtelHtmlError('version-mismatch', {
      message: `cannot append: the report at ${out} is format ${manifest.formatVersion}; writer.format local or site writes format 5`,
      path: 'manifest.formatVersion',
      hint: `use merge to convert: \`otel-html merge ${out} -o <dir> --format ${format}\``,
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
