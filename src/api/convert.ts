import type { ConfigInput } from '../config/schema.js';
import { readOtlpFile } from '../model/detect.js';
import { OtelHtmlError } from '../model/errors.js';
import type { OtlpSignal } from '../model/otlp-json.js';
import { mergeReports } from '../writer/merge.js';
import type { FileSystem } from '../writer/ports.js';
import { openSession, type ReportSummary, type WriterDeps } from '../writer/session.js';
import { resolveApiConfig, resolveDeps } from './report.js';

export interface ConvertOptions {
  /** OTLP files: JSON, JSON lines or protobuf (`.pb` / `.binpb`). Read in the order given. */
  input: string | readonly string[];
  out: string;
  /** A config object or the path of an `otel-html.yaml`. Environment variables are not read. */
  config?: ConfigInput | string;
  /** The signal of protobuf inputs, which do not say. */
  signal?: OtlpSignal;
  /** Reopen an existing report (same otel-html version) and add to it instead of replacing it. */
  append?: boolean;
}

export interface MergeOptions {
  /** Report folders to combine. */
  inputs: readonly string[];
  out: string;
  /** A config object or the path of an `otel-html.yaml`. Environment variables are not read. */
  config?: ConfigInput | string;
}

/** Build a report from OTLP files. */
export async function convert(options: ConvertOptions, deps?: Partial<WriterDeps>): Promise<ReportSummary> {
  const files = typeof options.input === 'string' ? [options.input] : options.input;
  if (files.length === 0) {
    throw new OtelHtmlError('usage', { message: 'no input files', hint: 'pass at least one OTLP file' });
  }
  const full = await resolveDeps(deps);
  const config = await resolveApiConfig(full, options.config, undefined);
  const session = await openSession(full, {
    out: options.out,
    config,
    mode: options.append === true ? 'append' : 'create',
  });
  try {
    for (const file of files) {
      for await (const request of readOtlpFile(inputPieces(full.fs, file), file, options.signal)) {
        await session.add(request, file);
      }
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
  return mergeReports(full, options.inputs, { out: options.out, config, mode: 'create' });
}
