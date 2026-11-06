import type { ResolvedConfig } from '../config/schema.js';
import { MANIFEST_PATH } from '../format/paths.js';
import { OtelHtmlError } from '../model/errors.js';
import type { CompiledCondition } from '../ottl/compile.js';
import { compileAny } from '../ottl/compile.js';
import { at, isReportFolder } from './checkpoint.js';
import type { Clock, FileSystem } from './ports.js';

export const DEFAULT_TITLE = 'otel-html report';

/** What opening a session shares between the chunk and the partition format. */
export type OpenMode = 'open' | 'append' | 'replace';

export interface Drops {
  span: CompiledCondition<'span'>;
  log: CompiledCondition<'log_record'>;
  point: CompiledCondition<'datapoint'>;
}

export function iso(clock: Clock): string {
  return new Date(Number(clock.nowUnixNano() / 1_000_000n)).toISOString();
}

/** Bad OTTL must fail before anything is written (or locked). */
export function compileDrops(config: ResolvedConfig): Drops {
  return {
    span: compileAny(config.writer.drop.traces.span, 'span'),
    log: compileAny(config.writer.drop.logs.log_record, 'log_record'),
    point: compileAny(config.writer.drop.metrics.datapoint, 'datapoint'),
  };
}

export interface FolderState {
  /** The folder holds a report this session resumes. */
  appending: boolean;
  /** The folder holds a report that a new one replaces. */
  preexisting: boolean;
}

/** The folder checks before anything is created or locked, so a wrong folder is left untouched. */
export async function inspectFolder(fs: FileSystem, out: string, mode: OpenMode): Promise<FolderState> {
  const appending = mode === 'append' || (mode === 'open' && (await fs.exists(at(out, MANIFEST_PATH))));
  let preexisting = false;
  if (!appending) {
    if (await fs.exists(out)) {
      const names = await fs.list(out);
      preexisting = names.length > 0;
      if (preexisting && !(await isReportFolder(fs, out))) {
        throw new OtelHtmlError('usage', {
          message: `refusing to write into ${out}: the folder is not empty and is not an otel-html report`,
          hint: 'choose an empty or new folder, or an existing report folder to replace it',
        });
      }
    }
  }
  if (mode === 'append' && !(await fs.exists(at(out, MANIFEST_PATH)))) {
    throw new OtelHtmlError('usage', {
      message: `cannot append: no report found at ${out} (missing ${MANIFEST_PATH})`,
      hint: 'the folder holds no report; drop --append to create one',
    });
  }
  return { appending, preexisting };
}
