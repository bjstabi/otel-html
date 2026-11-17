import { type ExprNode, Query, sql, verbatim } from '@uwdata/mosaic-sql';
import { VAR_COLUMN_PREFIX } from '../../format/parquet/columns.js';

/**
 * Partitions whose `widget_traces` index answers a traces widget's condition: their index files, the condition id and
 * the bound variables (`key` without the `var:` prefix, a string `value`).
 */
export interface WidgetIndexRoute {
  files: readonly string[];
  condition: string;
  bindings: readonly { key: string; value: string }[];
}

const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;
const ident = (text: string): string => `"${text.replaceAll('"', '""')}"`;

/**
 * The `trace_id`s of the index rows of `route`, one per index row (a trace repeats per variable tuple and partition).
 * The files are read inline with `union_by_name`: partitions differ in their `var:` columns, and only bound keys are
 * filtered (the router sends only partitions whose index holds every bound key).
 */
export function widgetIndexRelation(route: WidgetIndexRoute): ExprNode {
  const terms = [
    `condition = ${quoted(route.condition)}`,
    ...route.bindings.map((b) => `${ident(VAR_COLUMN_PREFIX + b.key)} = ${quoted(b.value)}`),
  ];
  const read = `read_parquet([${route.files.map(quoted).join(', ')}], union_by_name = true)`;
  return Query.from({ widget_traces: verbatim(read) })
    .select('trace_id')
    .where(sql`${verbatim(terms.join(' AND '))}`);
}
