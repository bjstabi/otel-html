import type { ConfigInput, ResolvedConfig } from '../config/schema.js';
import { readOtlpFile } from '../model/detect.js';
import { OtelHtmlError } from '../model/errors.js';
import type { OtlpSignal } from '../model/otlp-json.js';
import { mergeReports } from '../writer/merge.js';
import type { FileSystem } from '../writer/ports.js';
import { openSession, type ReportSummary, type WriterDeps } from '../writer/session.js';
import { resolveApiConfig, resolveDeps, sessionModeOf } from './report.js';

export interface ConvertOptions {
  /** OTLP files: JSON, JSON lines or protobuf (`.pb` / `.binpb`). Read in the order given. */
  input: string | readonly string[];
  out: string;
  /** A config object or the path of an `otel-html.yaml`. Environment variables are not read. */
  config?: ConfigInput | string;
  /** The signal of protobuf inputs, which do not say. */
  signal?: OtlpSignal;
  /** Require a report at `out` (fail when there is none). */
  append?: boolean;
  /** Start the report over, even when `out` already holds one. */
  replace?: boolean;
}

export interface MergeOptions {
  /** Report folders to combine. */
  inputs: readonly string[];
  out: string;
  /** A config object or the path of an `otel-html.yaml`. Environment variables are not read. */
  config?: ConfigInput | string;
  /** Require a report at `out` (fail when there is none). */
  append?: boolean;
  /** Start the report over, even when `out` already holds one. */
  replace?: boolean;
}

/** Build a report from OTLP files. */
export async function convert(options: ConvertOptions, deps?: Partial<WriterDeps>): Promise<ReportSummary> {
  const full = await resolveDeps(deps);
  const config = await resolveApiConfig(full, options.config, undefined);
  return convertResolved({ ...options, config }, full);
}

/** Internal (the CLI): like `convert`, with config already resolved so dashboard sources are kept. */
export async function convertResolved(
  options: Omit<ConvertOptions, 'config'> & { config: ResolvedConfig },
  full: WriterDeps,
): Promise<ReportSummary> {
  const config = options.config;
  const files = typeof options.input === 'string' ? [options.input] : options.input;
  if (files.length === 0) {
    throw new OtelHtmlError('usage', { message: 'no input files', hint: 'pass at least one OTLP file' });
  }
  const session = await openSession(full, {
    out: options.out,
    config,
    mode: sessionModeOf(options),
  });
  try {
    for (const file of files) {
      for await (const request of readOtlpFile(inputPieces(full.fs, file), file, options.signal)) {
        await session.add(request, file, { partial: true });
      }
      await session.endInput();
    }
    return await session.close();
  } catch (e) {
    await session.abort().catch(() => undefined); // never mask the original error
    throw e;
  }
}

/** A file's bytes in pieces; a failed read is a usage error naming the file. */
async function* inputPieces(fs: FileSystem, file: string): AsyncGenerator<Uint8Array, void, undefined> {
  try {
    if (fs.readChunks === undefined) yield await fs.readBytes(file);
    else yield* fs.readChunks(file);
  } catch (e) {
    throw new OtelHtmlError('usage', {
      message: `cannot read input file ${file}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/** Combine finished reports into a new one, de-duplicating spans and keeping absolute times. */
export async function merge(options: MergeOptions, deps?: Partial<WriterDeps>): Promise<ReportSummary> {
  const full = await resolveDeps(deps);
  const config = await resolveApiConfig(full, options.config, undefined);
  return mergeResolved({ ...options, config }, full);
}

/** Internal (the CLI): like `merge`, with config already resolved so dashboard sources are kept. */
export async function mergeResolved(
  options: Omit<MergeOptions, 'config'> & { config: ResolvedConfig },
  full: WriterDeps,
): Promise<ReportSummary> {
  return mergeReports(full, options.inputs, {
    out: options.out,
    config: options.config,
    mode: sessionModeOf(options),
  });
}
