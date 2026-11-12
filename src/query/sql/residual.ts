import { Query } from '@uwdata/mosaic-sql';

/** The temp table `name` of `columns` read from the registered text `<name>.csv`, each column of its `types` entry. */
export function idTableStatement(
  name: string,
  columns: readonly string[],
  types: readonly ('BIGINT' | 'VARCHAR')[],
): string {
  const spec = columns.map((c, i) => `'${c}': '${types[i]}'`).join(', ');
  return `CREATE TEMP TABLE ${name} AS SELECT * FROM read_csv('${name}.csv', header = true, columns = {${spec}})`;
}

/** The `columns` of the id table `name`, for an `IN (...)` over the rows a residual condition kept. */
export function idTableRowsQuery(table: string, columns: readonly string[]): Query {
  return Query.from(table).select(...columns);
}
