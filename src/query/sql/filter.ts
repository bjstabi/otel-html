import { and, column, type ExprNode, eq, gte, isIn, literal, lte, sql, verbatim } from '@uwdata/mosaic-sql';
import type { ManifestV4 } from '../../format/manifest.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId } from '../../model/ids.js';
import { textPredicate, translateCondition } from './ottl.js';
import { type AbsWindow, absWindow, type Pruned, prunePartitions, type RelWindow } from './prune.js';
import { partitionOfFilename } from './views.js';

export interface SqlFilter {
  /** The translated terms of the condition (and `trace_id = ?`), or null. */
  predicate: ExprNode | null;
  /** The text search predicate, or null. */
  text: ExprNode | null;
  /** The files of the filtered table the query reads. Hints from a condition prune this table only. */
  files: Pruned;
  window: AbsWindow | null;
  epoch: bigint;
}

export interface FilterOptions {
  manifest: ManifestV4;
  table: 'spans' | 'logs' | 'points';
  condition: string | null;
  text: string;
  window: RelWindow | null;
  /** Adds `trace_id = ?` and prunes to the partitions of `traceFiles` (the `traces` file names `tracePartitionsQuery` gives). */
  traceId?: TraceId | null;
  traceFiles?: readonly string[];
}

/**
 * The condition (translated, with its residual terms returned for the browser), the text search and the file pruning
 * for one table. Every user value goes through `literal`.
 */
export function buildFilter(opts: FilterOptions): { filter: SqlFilter; residual: string | null } {
  const context = opts.table === 'spans' ? 'span' : opts.table === 'points' ? 'datapoint' : 'log_record';
  const condition = opts.condition === null || opts.condition.trim() === '' ? null : opts.condition;
  const t = condition === null ? null : translateCondition(condition, context);
  const epoch = BigInt(opts.manifest.epochUnixNano);
  const window = absWindow(opts.window, epoch);
  const hints = t?.hints ?? new Map();
  if (opts.traceId != null && opts.traceFiles === undefined) {
    throw new OtelHtmlError('usage', {
      message: 'buildFilter: traceId needs traceFiles (the traces files tracePartitionsQuery names)',
    });
  }
  let files = prunePartitions(opts.manifest, opts.table, hints, window);
  if (opts.traceId != null && opts.traceFiles !== undefined) {
    const wanted = new Set(opts.traceFiles.map(partitionOfFilename));
    const kept = files.files.filter((p) => wanted.has(partitionOfFilename(p)));
    files = { files: kept, all: kept.length === files.total, total: files.total };
  }
  const predicate =
    opts.traceId == null
      ? (t?.predicate ?? null)
      : and(...(t?.predicate == null ? [] : [t.predicate]), eq(column('trace_id'), literal(opts.traceId)));
  return {
    filter: {
      predicate,
      text: textPredicate(opts.text, context),
      files,
      window,
      epoch,
    },
    residual: t?.residual ?? null,
  };
}

/** `filename IN (...)` unless every file is read; a table with no kept file is `false`. */
function filenameTerm(files: Pruned): ExprNode | null {
  if (files.all && files.files.length > 0) return null;
  if (files.files.length === 0) return literal(false);
  return isIn(
    column('filename'),
    files.files.map((p) => literal(p)),
  );
}

/**
 * The WHERE terms: predicate, text, `filename IN (...)` unless all files are read, and the window: spans (and
 * traces) overlapping it, `end >= start_abs AND start <= end_abs`, logs `coalesce(time, observed) BETWEEN`, points `time_unix_nano BETWEEN`.
 */
export function whereOf(f: SqlFilter, table: 'spans' | 'logs' | 'points'): ExprNode[] {
  const terms: ExprNode[] = [];
  if (f.predicate !== null) terms.push(f.predicate);
  if (f.text !== null) terms.push(f.text);
  const files = filenameTerm(f.files);
  if (files !== null) terms.push(files);
  if (f.window !== null) {
    const lo = verbatim(`${f.window.start}::BIGINT`);
    const hi = verbatim(`${f.window.end}::BIGINT`);
    if (table === 'logs') {
      const t = sql`coalesce(${column('time_unix_nano')}, ${column('observed_time_unix_nano')})`;
      terms.push(and(gte(t, lo), lte(t, hi)));
    } else if (table === 'points') {
      const t = column('time_unix_nano');
      terms.push(and(gte(t, lo), lte(t, hi)));
    } else {
      terms.push(gte(column('end_time_unix_nano'), lo), lte(column('start_time_unix_nano'), hi));
    }
  }
  return terms;
}
