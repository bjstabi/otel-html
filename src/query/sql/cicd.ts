import {
  and,
  column,
  type ExprNode,
  eq,
  gte,
  isIn,
  literal,
  lt,
  or,
  Query,
  sql,
  verbatim,
} from '@uwdata/mosaic-sql';
import { TABLE_COLUMNS } from '../../format/parquet/columns.js';
import { filenameTerm } from './filter.js';
import type { AbsWindow, Pruned } from './prune.js';

/** The run-level columns a request can narrow the runs by. */
export type CicdRunColumn = 'pipeline' | 'trigger' | 'branch';

/** Which runs a `cicd` request wants: the run rows that start in `window` (absolute) and equal every `equals` entry. */
export interface CicdSelection {
  window: AbsWindow | null;
  equals: readonly { column: CicdRunColumn; value: string }[];
}

const CICD_COLUMNS: readonly string[] = TABLE_COLUMNS.cicd.map((c) => c.name);

/** The run rows of `sel`, as `WHERE` terms over the `cicd` view. */
function runTerms(sel: CicdSelection): ExprNode[] {
  const terms: ExprNode[] = [eq(column('kind'), literal('run'))];
  if (sel.window !== null) {
    const start = column('start_ns');
    terms.push(
      and(
        gte(start, verbatim(`${sel.window.start}::BIGINT`)),
        lt(start, verbatim(`${sel.window.end}::BIGINT`)),
      ),
    );
  }
  for (const e of sel.equals) terms.push(eq(column(e.column), literal(e.value)));
  return terms;
}

/**
 * Every column of the `cicd` rows of the traces whose run row is selected, plus `selected`: whether the trace is
 * selected by the files read (its other rows may sit in any partition, so each row is returned whatever file it is in).
 * `alsoTraces` are traces selected elsewhere (by a scan of partitions without the table): their rows are returned too.
 */
export function cicdRowsQuery(sel: CicdSelection, alsoTraces: readonly string[]): Query {
  const runs = Query.from('cicd')
    .select('trace_id')
    .where(...runTerms(sel));
  const inRuns = sql`${column('trace_id')} IN (${runs})`;
  const q = Query.from('cicd').select(...CICD_COLUMNS, { selected: inRuns });
  q.where(
    alsoTraces.length === 0
      ? inRuns
      : or(
          inRuns,
          isIn(
            column('trace_id'),
            alsoTraces.map((t) => literal(t)),
          ),
        ),
  );
  return q;
}

/**
 * The span columns a `cicd` derivation reads, of the spans files in `files` (the partitions without the table).
 * `filename` says which partition a row is from.
 */
export function cicdSpansQuery(files: Pruned): Query {
  const q = Query.from('spans').select(
    'filename',
    'trace_id',
    'span_id',
    'parent_span_id',
    'name',
    'start_time_unix_nano',
    'end_time_unix_nano',
    'status_code',
    'attributes',
    'resource_attributes',
    'scope_name',
  );
  const own = filenameTerm(files);
  if (own !== null) q.where(own);
  return q;
}
