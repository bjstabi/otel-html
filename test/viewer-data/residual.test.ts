import { describe, expect, test } from 'vitest';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import { idTable } from '../../src/viewer/data/residual.js';

function recorder(): { engine: QueryEngine; texts: Map<string, string>; statements: string[] } {
  const texts = new Map<string, string>();
  const statements: string[] = [];
  const engine: QueryEngine = {
    tempTables: true,
    query: () => Promise.reject(new Error('no query')),
    exec: (s) => {
      statements.push(s);
      return Promise.resolve();
    },
    registerText: (name, text) => {
      texts.set(name, text);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  return { engine, texts, statements };
}

describe('idTable', () => {
  test('numbers are BIGINT columns, strings VARCHAR and quoted', async () => {
    const { engine, texts, statements } = recorder();
    const name = await idTable(engine, ['filename', 'file_row_number'], [['a"b.parquet', 3]]);
    expect(texts.get(`${name}.csv`)).toBe('filename,file_row_number\n"a""b.parquet",3');
    expect(statements[0]).toContain("'filename': 'VARCHAR', 'file_row_number': 'BIGINT'");
  });

  test('a series_id column is VARCHAR, and an empty table keeps file_row_number BIGINT', async () => {
    const { engine, statements } = recorder();
    await idTable(engine, ['series_id'], [['ab12']]);
    await idTable(engine, ['filename', 'file_row_number'], []);
    expect(statements[0]).toContain("'series_id': 'VARCHAR'");
    expect(statements[1]).toContain("'filename': 'VARCHAR', 'file_row_number': 'BIGINT'");
  });
});
