import { and, type ExprNode, or, sql, verbatim } from '@uwdata/mosaic-sql';

/**
 * The keyset position after the last row of a page: the time column the list sorts by (`start_time_unix_nano`,
 * absolute, for spans; `time_rel`, relative to the epoch, for logs) and the ascending tie-breakers of the ORDER BY.
 * `spanId` is the span list's extra tie-breaker (its ORDER BY is time, `span_id`, file, row) and required there.
 */
export interface RowCursor {
  time: bigint;
  filename: string;
  row: bigint;
  spanId?: string;
}

/**
 * `time` past `at` in `dir`, or at it with the ascending `rest` columns past the cursor's values (a row-value
 * comparison: the tie-breakers of every list's ORDER BY are ascending whatever the direction).
 */
export function keysetAfter(
  time: string,
  dir: 'asc' | 'desc',
  at: bigint,
  rest: readonly (readonly [string, ExprNode])[],
): ExprNode {
  const t = verbatim(`${at}::BIGINT`);
  const names = rest.map(([n]) => `"${n}"`).join(', ');
  const values = rest.map(([, v]) => String(v)).join(', ');
  const col = `"${time}"`;
  const past = dir === 'asc' ? sql`${verbatim(col)} > ${t}` : sql`${verbatim(col)} < ${t}`;
  return or(past, and(sql`${verbatim(col)} = ${t}`, sql`(${verbatim(names)}) > (${verbatim(values)})`));
}

const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * A relation over exactly `files`, read in the order given, with the virtual columns of the shared views
 * (`filename`, `file_row_number`): a time-sorted rows statement reads its own list, newest partition first for a
 * descending sort and oldest first for an ascending one, which the one shared view (oldest first) cannot do for both.
 */
export const ownFiles = (files: readonly string[]): ExprNode =>
  sql`${verbatim(`read_parquet([${files.map(quoted).join(', ')}], filename = true, file_row_number = true, union_by_name = false)`)}`;
