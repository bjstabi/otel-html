import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { decodeColumns } from '../format/columns.js';
import { reviveDataJson, unwrapDataFile } from '../format/data-file.js';
import {
  isPartitioned,
  type Manifest,
  type ManifestChunk,
  type ManifestV4,
  parseAnyManifest,
  parseManifest,
} from '../format/manifest.js';
import { MANIFEST_KEY, MANIFEST_PATH, type Signal } from '../format/paths.js';
import { LOG_COLUMNS, METRIC_COLUMNS, SPAN_COLUMNS } from '../format/specs.js';
import { CHUNK_READABLE_FORMAT_VERSIONS, READABLE_PARTITION_FORMATS } from '../format/version.js';
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

interface Located {
  dir: string;
  file: string;
  raw: unknown;
}

/** The report's manifest, unwrapped but not parsed. `verb` names the command in the usage error when there is no report. */
async function locateManifest(fs: FileSystem, rawDir: string, verb: string): Promise<Located> {
  const dir = trimSlashes(rawDir);
  const file = at(dir, MANIFEST_PATH);
  if (!(await fs.exists(file))) {
    throw new OtelHtmlError('usage', {
      message: `cannot ${verb}: no report found at ${dir} (missing ${MANIFEST_PATH})`,
      hint: 'pass report folders (the ones containing index.html)',
    });
  }
  const text = await readFile(fs, file, 'the manifest');
  return { dir, file, raw: inFile(file, () => reviveDataJson(unwrapDataFile(text, MANIFEST_KEY))) };
}

/** Fails like the copy would: the path must be a file (or a link) that opens and yields its first bytes. Without `bytes` it reads one piece where the port can stream; with `bytes` the size is exact, and a port without `openBlob` streams (or reads) the whole file. */
async function assertReadable(fs: FileSystem, file: string, listed: string, bytes?: number): Promise<void> {
  const fail = (why: string): OtelHtmlError =>
    new OtelHtmlError('invalid-report', {
      message: `${file}: cannot read ${listed} listed in the manifest (${why})`,
    });
  const kind = await fs.entryKind(file);
  if (kind === 'missing') throw fail('it is missing');
  if (kind === 'dir' || kind === 'other') throw fail('it is not a file');
  try {
    const size = await sizeOf(fs, file, bytes !== undefined);
    if (bytes !== undefined && size !== bytes) {
      throw new OtelHtmlError('invalid-report', {
        message: `${file}: ${listed} is ${size} bytes, the manifest lists ${bytes}`,
      });
    }
  } catch (e) {
    if (e instanceof OtelHtmlError) throw e;
    throw fail(e instanceof Error ? e.message : String(e));
  }
}

/** The file's size when `exact`, else only that its first bytes read. Streams or slices: a partition is never held whole when the port can avoid it. */
async function sizeOf(fs: FileSystem, file: string, exact: boolean): Promise<number> {
  if (exact && fs.openBlob !== undefined) {
    const blob = await fs.openBlob(file);
    await blob.slice(0, 1).arrayBuffer(); // opens for real
    return blob.size;
  }
  if (fs.readChunks === undefined) return (await fs.readBytes(file)).length;
  let n = 0;
  for await (const piece of fs.readChunks(file)) {
    n += piece.length;
    if (!exact) break;
  }
  return n;
}

function chunkInput({ dir, file, raw }: Located, verb: string): Input {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'formatVersion' in raw &&
    !CHUNK_READABLE_FORMAT_VERSIONS.some((v) => v === raw.formatVersion)
  ) {
    // Chunk reports of every readable version lay out alike; anything else is another otel-html's to read.
    throw new OtelHtmlError('version-mismatch', {
      message: `${file}: unsupported report formatVersion ${JSON.stringify(raw.formatVersion)}; this otel-html reads formatVersion ${[...CHUNK_READABLE_FORMAT_VERSIONS, ...READABLE_PARTITION_FORMATS].join(', ')}`,
      hint: `run ${verb} with the otel-html version that wrote the report, or regenerate it from its OTLP input`,
    });
  }
  const manifest = inFile(file, () => parseManifest(raw));
  return {
    dir,
    manifest,
    epoch: inFile(file, () => parseUnixNanos(manifest.epochUnixNano, 'epochUnixNano')),
  };
}

/** A merge input: a chunk report to replay, or a format-4 report whose partitions are copied. */
type MergeInput = ({ kind: 'chunks' } & Input) | ({ kind: 'partitions' } & PartitionInput);

interface PartitionInput {
  dir: string;
  manifest: ManifestV4;
  epoch: UnixNanos;
}

/** The report at `rawDir` as merge (or, with another `verb`, that command) reads it: format 4 as partitions, anything else as chunks. */
export async function readMergeInput(fs: FileSystem, rawDir: string, verb = 'merge'): Promise<MergeInput> {
  const located = await locateManifest(fs, rawDir, verb);
  const { raw, file, dir } = located;
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'formatVersion' in raw &&
    READABLE_PARTITION_FORMATS.some((f) => f === raw.formatVersion)
  ) {
    const manifest = inFile(file, () => parseAnyManifest(raw));
    if (!isPartitioned(manifest))
      throw new Error('invariant violated: a partition manifest parsed as another format');
    return {
      kind: 'partitions',
      dir,
      manifest,
      epoch: inFile(file, () => parseUnixNanos(manifest.epochUnixNano, 'epochUnixNano')),
    };
  }
  return { kind: 'chunks', ...chunkInput(located, verb) };
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
  const loaded: MergeInput[] = [];
  for (const dir of dirs) loaded.push(await readMergeInput(deps.fs, dir));
  loaded.sort((a, b) => (a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0));
  for (const input of loaded) {
    if (!input.manifest.complete) {
      deps.logger.warn(`merging ${input.dir}, which was not closed cleanly; it may be missing recent data`);
    }
  }
  // An existing report at `out` is the base; the session's append branch inherits its title and dashboards.
  const intoExisting = options.mode !== 'replace' && (await deps.fs.exists(at(out, MANIFEST_PATH)));
  // Also before it: a replace wipes the old report at the session's first write, so every partition file and chunk an input lists must open.
  for (const input of loaded) {
    // Chunk inputs list no sizes; partition files do, and a truncated one would fail the copy after the wipe.
    const listed =
      input.kind === 'partitions'
        ? input.manifest.partitions.flatMap((e) =>
            Object.values(e.files).map((f) => ({ path: f.path, bytes: f.bytes })),
          )
        : input.manifest.chunks.map((c) => ({ path: c.path, bytes: undefined }));
    for (const { path, bytes } of listed) await assertReadable(deps.fs, at(input.dir, path), path, bytes);
  }
  const first = loaded[0];
  const titled =
    options.config.title === undefined && first !== undefined
      ? { ...options.config, title: first.manifest.title }
      : options.config;
  const config =
    intoExisting || first === undefined ? options.config : inheritDashboards(titled, first.manifest.config);
  const session = await openSession(deps, { ...options, out, config });
  try {
    for (const [origin, input] of loaded.entries()) {
      if (input.kind === 'partitions') {
        if (session.copyPartitions === undefined) {
          throw new Error('invariant violated: a partition input reached a session that cannot copy it');
        }
        await session.copyPartitions({
          origin,
          dir: input.dir,
          epoch: input.epoch,
          totals: input.manifest.totals,
          range: input.manifest.range,
          partitions: input.manifest.partitions,
        });
        continue;
      }
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
