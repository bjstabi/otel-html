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

const csvCell = (v: string): string => `"${v.replaceAll('"', '""')}"`;

/**
 * D5: a temp table `(filename, file_row_number)` of the surviving rows, for an aggregate query to join on. Every call
 * makes a fresh name (the coordinator caches by SQL text); pass it to `dropResidualTable` when done.
 */
export async function residualIdTable(
  engine: QueryEngine,
  ids: readonly { filename: string; row: number }[],
): Promise<string> {
  const name = `otel_residual_${++tables}`;
  const lines = ids.map((i) => `${csvCell(i.filename)},${i.row}`);
  await engine.registerText(`${name}.csv`, ['filename,file_row_number', ...lines].join('\n'));
  try {
    await engine.exec(
      `CREATE TEMP TABLE ${name} AS SELECT * FROM read_csv('${name}.csv', header = true, columns = {'filename': 'VARCHAR', 'file_row_number': 'BIGINT'})`,
    );
  } catch (error) {
    await engine.registerText(`${name}.csv`, '').catch(() => undefined); // do not leave the text registered
    throw error;
  }
  return name;
}

/**
 * Drops a table `residualIdTable` made and empties its registered text. Both steps always run; the first failure is
 * rethrown after the second ran.
 */
export async function dropResidualTable(engine: QueryEngine, name: string): Promise<void> {
  const results = await Promise.allSettled([
    engine.exec(`DROP TABLE IF EXISTS ${name}`),
    engine.registerText(`${name}.csv`, ''),
  ]);
  for (const r of results) if (r.status === 'rejected') throw r.reason;
}
