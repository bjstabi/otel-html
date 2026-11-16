import '../../../src/writer/parquet-wasm-source.js';
import { expect, test } from 'vitest';
import { decodeTable, encodeTable } from '../../../src/format/parquet/codec.js';
import type { Row } from '../../../src/format/parquet/rows.js';
import { openTestDb } from '../../../test-support/duckdb-node.js';

function span(i: number): Row {
  const start = 1_700_000_000_000_000_000n + BigInt((i * 7919) % 1000) * 1_000_000n;
  return {
    trace_id: `trace-${i}`,
    span_id: `span-${i}`,
    name: `op${i % 7}`,
    start_time_unix_nano: start,
    end_time_unix_nano: start + 10n,
    duration_ns: 10n,
    attributes: '{"a":1}',
    scope_name: `scope${i % 3}`,
    service_name: `svc${i % 5}`,
  };
}

const get = (row: Record<string, unknown> | undefined, key: string): unknown => row?.[key];
const rows = Array.from({ length: 1000 }, (_, i) => span(i));
const opts = { rowGroupRows: 50_000 };

test('a layout sorts by its keys, desc included, and sets row groups and dictionaries', async () => {
  const bytes = encodeTable('spans', rows, {
    ...opts,
    layout: {
      sort: {
        spans: [
          { column: 'scope_name', dir: 'asc' },
          { column: 'start_time_unix_nano', dir: 'desc' },
        ],
      },
      rowGroupRows: 100,
      noDictionary: ['trace_id'],
    },
  });
  const decoded = decodeTable('spans', bytes);
  const keys = decoded.map((r) => ({
    scope: String(get(r, 'scope_name')),
    start: BigInt(get(r, 'start_time_unix_nano') as bigint),
  }));
  const want = [...keys].sort((a, b) =>
    a.scope === b.scope ? (a.start > b.start ? -1 : a.start < b.start ? 1 : 0) : a.scope < b.scope ? -1 : 1,
  );
  expect(keys).toEqual(want);

  const db = await openTestDb();
  try {
    db.registerFile('f.parquet', bytes);
    const meta = db.rows(
      `SELECT path_in_schema AS col, count(*) AS chunks, count(dictionary_page_offset) AS dicts, max(row_group_num_rows) AS rows FROM parquet_metadata('f.parquet') WHERE path_in_schema IN ('trace_id', 'service_name') GROUP BY 1`,
    );
    const by = (c: string, field: string): number =>
      Number(
        get(
          meta.find((m) => get(m, 'col') === c),
          field,
        ),
      );
    expect(by('trace_id', 'chunks')).toBe(10);
    expect(by('trace_id', 'rows')).toBe(100);
    expect(by('trace_id', 'dicts')).toBe(0);
    expect(by('service_name', 'dicts')).toBe(10);
  } finally {
    db.close();
  }
});

test('a missing layout writes the bytes main writes', () => {
  const plain = encodeTable('spans', rows, opts);
  expect(encodeTable('spans', rows, { ...opts, layout: {} })).toEqual(plain);
});
