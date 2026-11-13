import {
  and,
  column,
  type ExprNode,
  eq,
  gte,
  isIn,
  literal,
  lt,
  lte,
  sql,
  verbatim,
} from '@uwdata/mosaic-sql';
import type { ManifestV4 } from '../../format/manifest.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId } from '../../model/ids.js';
import { type PruneHints, textPredicate, translateCondition } from './ottl.js';
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
  /** Long-window rules apply (spec §6.3): selection by start time, `lo <= start < hi`. */
  long: boolean;
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
  /** Statistics hints beside the condition's (a key both name keeps the values both allow), e.g. `metric_name` for a points query. */
  hints?: PruneHints;
  /** The window (or, with none, the report's range) is long (`isLongWindow`). */
  long?: boolean;
}

/** `buildFilter`'s result: the filter, the residual terms, what the translated terms read and the statistics hints that pruned `filter.files`. */
export interface BuiltFilter {
  filter: SqlFilter;
  residual: string | null;
  /** Statistics-key grammar (`service_name`, `resource:run.id`, `attr:*`); the `trace_id` of a trace-scoped read is in it. */
  reads: ReadonlySet<string>;
  hints: PruneHints;
}

function mergeHints(own: PruneHints, extra: PruneHints | undefined): PruneHints {
  if (extra === undefined) return own;
  const out = new Map(own);
  for (const [key, wanted] of extra) {
    const have = out.get(key);
    out.set(key, have === undefined ? wanted : new Set([...have].filter((v) => wanted.has(v))));
  }
  return out;
}

/**
 * The condition (translated, with its residual terms returned for the browser), the text search and the file pruning
 * for one table. Every user value goes through `literal`.
 */
export function buildFilter(opts: FilterOptions): BuiltFilter {
  const context = opts.table === 'spans' ? 'span' : opts.table === 'points' ? 'datapoint' : 'log_record';
  const condition = opts.condition === null || opts.condition.trim() === '' ? null : opts.condition;
  const t = condition === null ? null : translateCondition(condition, context);
  const epoch = BigInt(opts.manifest.epochUnixNano);
  const long = opts.long === true;
  const window = absWindow(opts.window, epoch);
  const hints = mergeHints(t?.hints ?? new Map(), opts.hints);
  if (opts.traceId != null && opts.traceFiles === undefined) {
    throw new OtelHtmlError('usage', {
      message: 'buildFilter: traceId needs traceFiles (the traces files tracePartitionsQuery names)',
    });
  }
  let files = prunePartitions(opts.manifest, opts.table, hints, window, undefined, { long });
  if (opts.traceId != null && opts.traceFiles !== undefined) {
    const wanted = new Set(opts.traceFiles.map(partitionOfFilename));
    const kept = files.files.filter((p) => wanted.has(partitionOfFilename(p)));
    files = { files: kept, all: kept.length === files.total, total: files.total };
  }
  const predicate =
    opts.traceId == null
      ? (t?.predicate ?? null)
      : and(...(t?.predicate == null ? [] : [t.predicate]), eq(column('trace_id'), literal(opts.traceId)));
  const reads = new Set(t?.reads ?? []);
  if (opts.traceId != null) reads.add('trace_id');
  return {
    reads,
    hints,
    filter: {
      predicate,
      text: textPredicate(opts.text, context),
      files,
      window,
      epoch,
      long,
    },
    residual: t?.residual ?? null,
  };
}

/** `filename IN (...)` unless every file is read; a table with no kept file is `false`. */
export function filenameTerm(files: Pruned): ExprNode | null {
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
 * Under `long` every table is selected by its own time, `>= lo AND < hi`; no window adds no term.
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
    const upper = f.long ? lt : lte;
    if (table === 'logs') {
      const t = sql`coalesce(${column('time_unix_nano')}, ${column('observed_time_unix_nano')})`;
      terms.push(and(gte(t, lo), upper(t, hi)));
    } else if (table === 'points') {
      const t = column('time_unix_nano');
      terms.push(and(gte(t, lo), upper(t, hi)));
    } else if (f.long) {
      const t = column('start_time_unix_nano');
      terms.push(and(gte(t, lo), lt(t, hi)));
    } else {
      terms.push(gte(column('end_time_unix_nano'), lo), lte(column('start_time_unix_nano'), hi));
    }
  }
  return terms;
}
