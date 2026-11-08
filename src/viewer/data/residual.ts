import type { QueryEngine } from './query-engine.js';

/** Row-list pages the browser re-check reads at most (D5), each of `limit` rows. */
const MAX_PAGES = 8;

/**
 * D5: pages of `limit` candidate rows through `fetch(limit, offset)`, keeping the rows `test` accepts, until `limit`
 * survivors, the end of the candidates or `MAX_PAGES` pages. `exhausted` is true when every candidate was read.
 */
export async function residualRows<T>(opts: {
  fetch: (limit: number, offset: number) => Promise<T[]>;
  test: (row: T) => boolean;
  limit: number;
}): Promise<{ rows: T[]; exhausted: boolean }> {
  const { limit } = opts;
  const rows: T[] = [];
  if (limit <= 0) return { rows, exhausted: false };
  for (let page = 0; page < MAX_PAGES; page++) {
    const candidates = await opts.fetch(limit, page * limit);
    for (const c of candidates) {
      if (!opts.test(c)) continue;
      if (rows.length === limit) return { rows, exhausted: false };
      rows.push(c);
    }
    if (candidates.length < limit) return { rows, exhausted: true };
  }
  return { rows, exhausted: false };
}

let tables = 0;

const csvCell = (v: string | number): string =>
  typeof v === 'number' ? String(v) : `"${v.replaceAll('"', '""')}"`;

/** Columns that are integers even when no row says so (an empty table must still compare with the integer column). */
const BIGINT_COLUMNS: ReadonlySet<string> = new Set(['file_row_number']);

/**
 * D5: a temp table of `columns` holding `rows`, for an aggregate query to join on (`filename`, `file_row_number` for
 * spans and logs; `series_id` for metrics, D22). A column is BIGINT when every value is a number (or it is
 * `file_row_number`), else VARCHAR. Every call makes a fresh name (the coordinator caches by SQL text); pass it to
 * `dropResidualTable` when done.
 */
export async function idTable(
  engine: QueryEngine,
  columns: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): Promise<string> {
  const name = `otel_residual_${++tables}`;
  const types = columns.map((c, i) =>
    BIGINT_COLUMNS.has(c) || (rows.length > 0 && rows.every((r) => typeof r[i] === 'number'))
      ? 'BIGINT'
      : 'VARCHAR',
  );
  const lines = rows.map((r) => r.map(csvCell).join(','));
  await engine.registerText(`${name}.csv`, [columns.join(','), ...lines].join('\n'));
  try {
    const spec = columns.map((c, i) => `'${c}': '${types[i]}'`).join(', ');
    await engine.exec(
      `CREATE TEMP TABLE ${name} AS SELECT * FROM read_csv('${name}.csv', header = true, columns = {${spec}})`,
    );
  } catch (error) {
    await engine.registerText(`${name}.csv`, '').catch(() => undefined); // do not leave the text registered
    throw error;
  }
  return name;
}

/**
 * Drops a table `idTable` made and empties its registered text. Both steps always run; the first failure is
 * rethrown after the second ran.
 */
export async function dropResidualTable(engine: QueryEngine, name: string): Promise<void> {
  const results = await Promise.allSettled([
    engine.exec(`DROP TABLE IF EXISTS ${name}`),
    engine.registerText(`${name}.csv`, ''),
  ]);
  for (const r of results) if (r.status === 'rejected') throw r.reason;
}
