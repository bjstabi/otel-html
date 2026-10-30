import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { decodeColumns } from '../format/columns.js';
import { reviveDataJson, unwrapDataFile } from '../format/data-file.js';
import { type Manifest, type ManifestChunk, parseManifest } from '../format/manifest.js';
import { MANIFEST_KEY, MANIFEST_PATH, type Signal } from '../format/paths.js';
import { LOG_COLUMNS, METRIC_COLUMNS, SPAN_COLUMNS } from '../format/specs.js';
import { READABLE_FORMAT_VERSIONS } from '../format/version.js';
import { OtelHtmlError } from '../model/errors.js';
import { parseUnixNanos, type UnixNanos } from '../model/ids.js';
import { at } from './checkpoint.js';
import { inheritDashboards } from './inherit-config.js';
import type { FileSystem } from './ports.js';
import {
  openSession,
  type RecordBatch,
  type ReportSummary,
  type SessionOptions,
  type WriterDeps,
} from './session.js';

interface Input {
  dir: string;
  manifest: Manifest;
  epoch: UnixNanos;
}

function trimSlashes(p: string): string {
  return p.replace(/\/+$/, '') || p;
}

/** Re-throw an invalid-report error with the offending file in front, so every message names it. */
function inFile<T>(file: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof OtelHtmlError && e.code === 'invalid-report') {
      throw new OtelHtmlError('invalid-report', { message: `${file}: ${e.message}`, ...hintOf(e) });
    }
    throw e;
  }
}

function hintOf(e: OtelHtmlError): { hint?: string } {
  return e.hint === undefined ? {} : { hint: e.hint };
}

async function readFile(fs: FileSystem, file: string, what: string): Promise<string> {
  try {
    return await fs.readText(file);
  } catch (e) {
    throw new OtelHtmlError('invalid-report', {
      message: `${file}: cannot read ${what} (${e instanceof Error ? e.message : String(e)})`,
    });
  }
}

async function loadInput(fs: FileSystem, rawDir: string): Promise<Input> {
  const dir = trimSlashes(rawDir);
  const file = at(dir, MANIFEST_PATH);
  if (!(await fs.exists(file))) {
    throw new OtelHtmlError('usage', {
      message: `cannot merge: no report found at ${dir} (missing ${MANIFEST_PATH})`,
      hint: 'pass report folders (the ones containing index.html)',
    });
  }
  const text = await readFile(fs, file, 'the manifest');
  const raw = inFile(file, () => reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'formatVersion' in raw &&
    !READABLE_FORMAT_VERSIONS.some((v) => v === raw.formatVersion)
  ) {
    // merge replays chunks, which every readable version lays out alike.
    throw new OtelHtmlError('version-mismatch', {
      message: `${file}: unsupported report formatVersion ${JSON.stringify(raw.formatVersion)}; this otel-html reads formatVersion ${READABLE_FORMAT_VERSIONS.join(' or ')}`,
      hint: 'merge the report with the otel-html version that wrote it, or regenerate it from its OTLP input',
    });
  }
  const manifest = inFile(file, () => parseManifest(raw));
  return {
    dir,
    manifest,
    epoch: inFile(file, () => parseUnixNanos(manifest.epochUnixNano, 'epochUnixNano')),
  };
}

async function readChunk(fs: FileSystem, input: Input, chunk: ManifestChunk): Promise<RecordBatch> {
  const file = at(input.dir, chunk.path);
  const text = await readFile(fs, file, `chunk ${chunk.path} listed in the manifest`);
  const key = chunk.path.slice('data/'.length, -'.js'.length);
  const payload = inFile(file, () => reviveDataJson(unwrapDataFile(text, key)));
  const { epoch } = input;
  const batch = inFile(file, (): RecordBatch => {
    switch (chunk.signal) {
      case 'spans': {
        const d = decodeColumns(SPAN_COLUMNS, payload);
        return { signal: 'spans', rows: d.rows, resources: d.resources, scopes: d.scopes, epoch };
      }
      case 'logs': {
        const d = decodeColumns(LOG_COLUMNS, payload);
        return { signal: 'logs', rows: d.rows, resources: d.resources, scopes: d.scopes, epoch };
      }
      case 'metrics': {
        const d = decodeColumns(METRIC_COLUMNS, payload);
        return { signal: 'metrics', rows: d.rows, resources: d.resources, scopes: d.scopes, epoch };
      }
    }
  });
  if (batch.rows.length !== chunk.count) {
    throw new OtelHtmlError('invalid-report', {
      path: file,
      expected: `${chunk.count} rows (from the manifest)`,
      actual: `${batch.rows.length} rows`,
    });
  }
  return batch;
}

/**
 * The output is created (and an existing report there replaced) before inputs are read, so it must not be
 * an input, inside one or contain one, however the paths are spelled.
 */
function assertDisjointPaths(out: string, input: string, o: string, i: string): void {
  const inside = (rel: string): boolean =>
    rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (o === i) {
    throw new OtelHtmlError('usage', { message: `${out} is also an input; merge into a different folder` });
  }
  if (inside(relative(o, i))) {
    throw new OtelHtmlError('usage', {
      message: `output ${out} contains input ${input}; merge into a different folder`,
    });
  }
  if (inside(relative(i, o))) {
    throw new OtelHtmlError('usage', {
      message: `output ${out} is inside input ${input}; merge into a different folder`,
    });
  }
}

/** `p` with its longest existing prefix canonicalised (symlinks, on-disk case) and the rest appended as written. */
async function canonical(fs: FileSystem, p: string): Promise<string> {
  const missing: string[] = [];
  let cur = p;
  for (;;) {
    if (await fs.exists(cur)) return resolve(await fs.realpath(cur), ...missing);
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    missing.unshift(basename(cur));
    cur = parent;
  }
}

/** Refuses an output that is, contains or sits inside an input, by spelling and by real location. */
async function assertDisjoint(fs: FileSystem, out: string, input: string): Promise<void> {
  assertDisjointPaths(out, input, resolve(out), resolve(input));
  assertDisjointPaths(out, input, await canonical(fs, out), await canonical(fs, input));
}

const SIGNAL_ORDER: readonly Signal[] = ['spans', 'logs', 'metrics'];

/**
 * Combine finished reports into one by replaying their data chunks (never their state) through a writer
 * session, so dedupe, rollups, the trace index and time rebasing are the writer's own. Inputs are read
 * oldest epoch first so the output epoch is the earliest one; every row keeps its absolute time.
 */
export async function mergeReports(
  deps: WriterDeps,
  inputs: readonly string[],
  options: SessionOptions,
): Promise<ReportSummary> {
  if (inputs.length === 0) {
    throw new OtelHtmlError('usage', { message: 'no input reports to merge' });
  }
  const out = trimSlashes(options.out);
  const dirs = inputs.map(trimSlashes);
  for (const dir of dirs) await assertDisjoint(deps.fs, out, dir);
  const loaded: Input[] = [];
  for (const dir of dirs) loaded.push(await loadInput(deps.fs, dir));
  loaded.sort((a, b) => (a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0));
  for (const input of loaded) {
    if (!input.manifest.complete) {
      deps.logger.warn(`merging ${input.dir}, which was not closed cleanly; it may be missing recent data`);
    }
  }
  const first = loaded[0];
  const titled =
    options.config.title === undefined && first !== undefined
      ? { ...options.config, title: first.manifest.title }
      : options.config;
  const config = first === undefined ? titled : inheritDashboards(titled, first.manifest.config);
  const session = await openSession(deps, { ...options, out, config });
  try {
    for (const [origin, input] of loaded.entries()) {
      for (const signal of SIGNAL_ORDER) {
        for (const chunk of input.manifest.chunks) {
          if (chunk.signal !== signal) continue;
          await session.addRecords({ ...(await readChunk(deps.fs, input, chunk)), origin });
        }
      }
    }
    return await session.close();
  } catch (e) {
    await session.abort().catch(() => undefined); // never mask the original error
    throw e;
  }
}
