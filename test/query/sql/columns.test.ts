import { verbatim } from '@uwdata/mosaic-sql';
import { describe, expect, test } from 'vitest';
import { TABLE_COLUMNS } from '../../../src/format/parquet/columns.js';
import { CONTEXTS } from '../../../src/ottl/contexts.js';
import {
  absLiteral,
  jsonAt,
  jsonKind,
  jsonNumber,
  jsonPointer,
  jsonStringAt,
  PATH_COLUMNS,
  relTime,
  toSql,
  UNMAPPED_PATHS,
} from '../../../src/query/sql/columns.js';
import { openTestDb } from '../../../test-support/duckdb-node.js';

type Row = { v?: unknown; rel?: unknown; abs?: unknown };
const json = (j: string) => verbatim(`'${j.replaceAll("'", "''")}'::JSON`);

describe('OTTL path to column map', () => {
  test('jsonPointer escapes ~ and / and takes numeric segments as indexes', () => {
    expect(jsonPointer(['a/b~c', 0, 'x'])).toBe('/a~1b~0c/0/x');
  });
  test('every OTTL path CONTEXTS knows is mapped or listed as unmapped', () => {
    for (const c of ['span', 'log_record'] as const) {
      for (const path of CONTEXTS[c].paths.keys())
        expect(PATH_COLUMNS[c].has(path) || UNMAPPED_PATHS[c].has(path), path).toBe(true);
    }
  });
  test('every mapped column exists in its table', () => {
    const tables = { span: 'spans', log_record: 'logs' } as const;
    for (const c of ['span', 'log_record'] as const) {
      const names = new Set(TABLE_COLUMNS[tables[c]].map((col) => col.name));
      for (const [path, pc] of PATH_COLUMNS[c]) expect(names.has(pc.column), `${c} ${path}`).toBe(true);
    }
  });
  test('null-reading paths are flagged', () => {
    expect(PATH_COLUMNS.span.get('parent_span_id.string')?.nullAsEmpty).toBe(true);
    expect(PATH_COLUMNS.log_record.get('observed_time_unix_nano')?.nullAsEmpty).toBe(true);
    expect(PATH_COLUMNS.log_record.get('event_name')?.nullAsEmpty).toBe(true);
    expect(PATH_COLUMNS.span.get('name')?.nullAsEmpty).toBeUndefined();
  });
});

describe('JSON access', () => {
  test('jsonAt and jsonStringAt read nested keys and indexes', async () => {
    const db = await openTestDb();
    try {
      const doc = '{"a/b":[{"x":"hi"},2],"n":null}';
      const one = (e: unknown) =>
        (db.rows(`SELECT ${toSql(e as never)} AS v FROM (SELECT '${doc}' AS c)`)[0] as Row | undefined)?.v;
      expect(one(jsonStringAt('c', ['a/b', 0, 'x']))).toBe('hi');
      expect(String(one(jsonAt('c', ['a/b', 1])))).toBe('2');
      expect(one(jsonStringAt('c', ['missing']))).toBeNull();
      expect(String(one(jsonAt('c', [])))).toContain('a/b');
    } finally {
      db.close();
    }
  });
  test('jsonNumber reads plain numbers and tagged ints and doubles', async () => {
    const db = await openTestDb();
    try {
      const v = (j: string) =>
        (db.rows(`SELECT ${toSql(jsonNumber(json(j)))} AS v`)[0] as Row | undefined)?.v;
      expect(v('3')).toBe(3);
      expect(v('-4')).toBe(-4);
      expect(v('1.5')).toBe(1.5);
      expect(v('{"$i":"9007199254740993"}')).toBe(9007199254740992);
      expect(v('{"$d":"3"}')).toBe(3);
      expect(v('{"$d":"Infinity"}')).toBe(Number.POSITIVE_INFINITY);
      expect(v('{"$d":"NaN"}')).toBeNaN();
      expect(v('"x"')).toBeNull();
      expect(v('true')).toBeNull();
      expect(v('null')).toBeNull();
      expect(v('{"a":1}')).toBeNull();
      expect(v('{"$m":[["$i","x"]]}')).toBeNull();
      expect(v('{"$m":[["$d","1"]]}')).toBeNull();
    } finally {
      db.close();
    }
  });
  test('jsonKind reads the format-4 encodings', async () => {
    const db = await openTestDb();
    try {
      const k = (j: string) => (db.rows(`SELECT ${toSql(jsonKind(json(j)))} AS v`)[0] as Row | undefined)?.v;
      expect(k('"s"')).toBe('string');
      expect(k('3')).toBe('int');
      expect(k('-3')).toBe('int');
      expect(k('{"$i":"9007199254740993"}')).toBe('int');
      expect(k('1.5')).toBe('double');
      expect(k('{"$d":"3"}')).toBe('double');
      expect(k('true')).toBe('bool');
      expect(k('{"a":1}')).toBe('map');
      expect(k('{"$m":[["$k",1]]}')).toBe('map');
      expect(k('{"$m":[["$i","x"]]}')).toBe('map');
      expect(k('{"$m":[["$d","1"]]}')).toBe('map');
      expect(k('[1,2]')).toBe('list');
      expect(k('{"$b":"AAE="}')).toBe('bytes');
      expect(k('null')).toBe('nil');
    } finally {
      db.close();
    }
  });
});

describe('epoch-relative times', () => {
  const epoch = 1_700_000_000_000_000_000n;
  test('relTime subtracts the epoch as BIGINT, absLiteral adds it back', async () => {
    const db = await openTestDb();
    try {
      const r = db.rows(
        `SELECT ${toSql(relTime('t', epoch))} AS rel, ${toSql(absLiteral(5, epoch))} AS abs FROM (SELECT ${epoch + 7n}::BIGINT AS t)`,
      )[0] as Row | undefined;
      expect(r?.rel).toBe(7n);
      expect(r?.abs).toBe(epoch + 5n);
    } finally {
      db.close();
    }
  });
});
