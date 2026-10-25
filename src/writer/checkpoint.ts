import { reviveDataJson, unwrapDataFile, wrapDataFile } from '../format/data-file.js';
import { type Manifest, parseManifest } from '../format/manifest.js';
import {
  LOCK_PATH,
  MANIFEST_KEY,
  MANIFEST_PATH,
  SIGNALS,
  type Signal,
  STATE_SLOTS,
  type StateSlot,
  statePath,
} from '../format/paths.js';
import { parseSessionState, type SessionState } from '../format/state.js';
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

export async function writeManifest(fs: FileSystem, out: string, manifest: Manifest): Promise<void> {
  parseManifest(manifest); // never write a manifest the viewer would reject
  await fs.writeTextAtomic(at(out, MANIFEST_PATH), wrapDataFile(MANIFEST_KEY, manifest));
}

export async function writeStateSlot(
  fs: FileSystem,
  out: string,
  slot: StateSlot,
  state: SessionState,
): Promise<void> {
  await fs.writeTextAtomic(at(out, statePath(slot)), JSON.stringify(state));
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

/**
 * Load the committed manifest and the state checkpoint that matches it. A flush interrupted after the
 * state write but before the manifest commit leaves the previous state in the other slot, which is the one
 * picked. Version and invalid-report handling for append beyond this is the append path's job.
 */
export async function loadCheckpoint(fs: FileSystem, out: string, version: string): Promise<Checkpoint> {
  const manifestPath = at(out, MANIFEST_PATH);
  if (!(await fs.exists(manifestPath))) {
    throw new OtelHtmlError('usage', {
      message: `cannot append: no report found at ${out} (missing ${MANIFEST_PATH})`,
      hint: 'use mode create to start a new report',
    });
  }
  const manifest = parseManifest(
    reviveDataJson(unwrapDataFile(await fs.readText(manifestPath), MANIFEST_KEY)),
  );
  if (manifest.otelHtmlVersion !== version) {
    throw new OtelHtmlError('version-mismatch', {
      path: 'manifest.otelHtmlVersion',
      expected: version,
      actual: manifest.otelHtmlVersion,
      hint: 'append needs the same otel-html version; combine the reports with `otel-html merge` instead',
    });
  }
  const problems: string[] = [];
  for (const slot of STATE_SLOTS) {
    const p = statePath(slot);
    if (!(await fs.exists(at(out, p)))) continue;
    let state: SessionState;
    try {
      state = parseSessionState(JSON.parse(await fs.readText(at(out, p))));
    } catch (e) {
      problems.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (state.otelHtmlVersion !== version) {
      throw new OtelHtmlError('version-mismatch', {
        path: `${p} otelHtmlVersion`,
        expected: version,
        actual: state.otelHtmlVersion,
        hint: 'append needs the same otel-html version; combine the reports with `otel-html merge` instead',
      });
    }
    if (consistent(state, manifest)) return { manifest, state, slot };
    problems.push(`${p}: does not match the committed manifest`);
  }
  throw new OtelHtmlError('invalid-report', {
    path: 'data/state',
    expected: 'a session checkpoint matching data/manifest.js',
    actual: problems.length === 0 ? 'no checkpoint files' : problems.join('; '),
    hint: 'combine the reports with `otel-html merge` instead of appending',
  });
}

const DATA_DIRS = [
  'data/chunks/spans',
  'data/chunks/logs',
  'data/chunks/metrics',
  'data/traces',
  'data/rollups',
  'data/state',
] as const;

export async function isReportFolder(fs: FileSystem, out: string): Promise<boolean> {
  return (await fs.exists(at(out, MANIFEST_PATH))) || (await fs.exists(at(out, LOCK_PATH)));
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
}
