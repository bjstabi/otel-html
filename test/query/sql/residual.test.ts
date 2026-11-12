import { expect, test } from 'vitest';
import { idTableRowsQuery, idTableStatement } from '../../../src/query/sql/residual.js';

test('idTableStatement creates a temp table from the registered csv with the given column types', () => {
  expect(idTableStatement('otel_residual_1', ['filename', 'file_row_number'], ['VARCHAR', 'BIGINT'])).toBe(
    "CREATE TEMP TABLE otel_residual_1 AS SELECT * FROM read_csv('otel_residual_1.csv', header = true, columns = {'filename': 'VARCHAR', 'file_row_number': 'BIGINT'})",
  );
  expect(idTableStatement('otel_residual_2', ['series_id'], ['VARCHAR'])).toBe(
    "CREATE TEMP TABLE otel_residual_2 AS SELECT * FROM read_csv('otel_residual_2.csv', header = true, columns = {'series_id': 'VARCHAR'})",
  );
});

test('idTableRowsQuery reads the columns of the id table back', () => {
  expect(String(idTableRowsQuery('otel_residual_1', ['filename', 'file_row_number']))).toBe(
    'SELECT "filename", "file_row_number" FROM "otel_residual_1"',
  );
});
