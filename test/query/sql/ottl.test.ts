import { describe, expect, test } from 'vitest';
import type { SqlContext } from '../../../src/query/sql/columns.js';
import { textPredicate, toSql, translateCondition } from '../../../src/query/sql/ottl.js';
import { openTestDb } from '../../../test-support/duckdb-node.js';

const bind = (value: string, name: string, body: string) =>
  `list_extract(list_transform([${value}], (${name}) -> ${body}), 1)`;
const NUM = (at: string) =>
  bind(
    at,
    'n',
    `CASE json_type(n)
    WHEN 'BIGINT' THEN TRY_CAST(n AS DOUBLE)
    WHEN 'UBIGINT' THEN TRY_CAST(n AS DOUBLE)
    WHEN 'DOUBLE' THEN TRY_CAST(n AS DOUBLE)
    WHEN 'OBJECT' THEN TRY_CAST(COALESCE(json_extract_string(n, '/$i'), json_extract_string(n, '/$d')) AS DOUBLE)
    ELSE NULL END`,
  );
/** One key read from a JSON column: the object member, else the `{"$m": [[k, v], ...]}` pair; the base bound once. */
const STEP = (col: string, key: string) =>
  bind(
    `CAST("${col}" AS JSON)`,
    'b0',
    `coalesce(json_extract(b0, '/${key}'), list_extract(list_transform(list_filter(from_json(json_extract(b0, '/$m'), '["JSON"]'), (x) -> json_extract_string(x, '/0') = '${key}'), (x) -> json_extract(x, '/1')), 1))`,
  );
const AT = STEP('attributes', 'http.status_code');
const NUM_GE_500 = `coalesce(${bind(NUM(AT), 'd', '((NOT isnan(d)) AND (d >= 500))')}, FALSE)`;

const cases: [string, SqlContext, string, string | null][] = [
  ['name == "GET /"', 'span', `("name" = 'GET /')`, null],
  ['status.code == STATUS_CODE_ERROR', 'span', `("status_code" = 2::BIGINT)`, null],
  ['attributes["http.status_code"] >= 500', 'span', NUM_GE_500, null],
  [
    'resource.attributes["service.name"] == "web" and IsMatch(name, "^GET")',
    'span',
    `(coalesce(${bind(STEP('resource_attributes', 'service.name'), 'v', `((json_type(v) = 'VARCHAR') AND (json_extract_string(v, '$') = 'web'))`)}, FALSE) AND regexp_matches(coalesce("name", ''), '^GET'))`,
    null,
  ],
  [
    'span.end_time_unix_nano - span.start_time_unix_nano > 1000000',
    'span',
    `((CAST("end_time_unix_nano" AS BIGINT) - CAST("start_time_unix_nano" AS BIGINT)) > 1000000::BIGINT)`,
    null,
  ],
  ['IsRootSpan()', 'span', `("parent_span_id" IS NULL)`, null],
  [
    'log.severity_number >= SEVERITY_NUMBER_WARN and Len(body) > 3',
    'log_record',
    `("severity_number" >= 13::BIGINT)`,
    'Len(body) > 3',
  ],
  ['trace_id.string == ""', 'log_record', `(coalesce("trace_id", '') = '')`, null],
];
describe('translateCondition', () => {
  test.each(cases)('%s', (src, ctx, sql, residual) => {
    const t = translateCondition(src, ctx);
    expect(t.predicate === null ? null : toSql(t.predicate)).toBe(sql);
    expect(t.residual).toBe(residual);
  });
  test('hints collect equality on statistics columns and resource keys', () => {
    expect(
      translateCondition(
        'resource.attributes["service.name"] == "web" and name == "a" and kind == SPAN_KIND_SERVER',
        'span',
      ).hints,
    ).toEqual(
      new Map([
        ['service_name', new Set(['web'])],
        ['name', new Set(['a'])],
      ]),
    );
    expect(translateCondition('resource.attributes["cicd.pipeline.run.id"] == 42', 'span').hints).toEqual(
      new Map([['resource:cicd.pipeline.run.id', new Set(['42'])]]),
    );
    expect(translateCondition('name != "a" or name == "b"', 'span').hints.size).toBe(0);
    expect(translateCondition('name == "a" or name == "b"', 'span').hints).toEqual(
      new Map([['name', new Set(['a', 'b'])]]),
    );
    expect(translateCondition('name == "a" and name == "b"', 'span').hints).toEqual(
      new Map([['name', new Set<string>()]]),
    );
    expect(translateCondition('name == "a" or Len(name) > 1', 'span').hints.size).toBe(0);
    expect(
      translateCondition('resource.attributes["service.name"] == 42', 'span').hints.has('service_name'),
    ).toBe(false);
    expect(
      translateCondition('resource.attributes["service.name"] == ""', 'span').hints.has('service_name'),
    ).toBe(false);
    expect(
      translateCondition('resource.attributes["service.name"] == true', 'span').hints.has('service_name'),
    ).toBe(false);
  });
  test('datapoint conditions translate over the points columns', () => {
    const t = translateCondition('metric.name == "a" and attributes["k"] == 3', 'datapoint');
    expect(t.predicate).not.toBeNull();
    expect(t.residual).toBeNull();
    expect(t.hints).toEqual(new Map([['metric_name', new Set(['a'])]]));
    expect(translateCondition('resource.attributes["service.name"] == "x"', 'datapoint').hints).toEqual(
      new Map([['service_name', new Set(['x'])]]),
    );
    const len = translateCondition('Len(attributes["k"]) > 2', 'datapoint');
    expect(len.predicate).toBeNull();
    expect(len.residual).toBe('Len(attributes["k"]) > 2');
    expect(textPredicate('abc', 'datapoint')).toBeNull();
  });
  test('a residual keeps its grouping and re-parses', () => {
    const t = translateCondition('(name == "a" or kind == 1) and Len(name) > 1', 'span');
    expect(t.residual).toBe('Len(name) > 1');
    const u = translateCondition('Len(name) > 1 and (Len(name) < 5 or Len(name) == 7)', 'span');
    expect(u.residual).toBe('Len(name) > 1 and (Len(name) < 5 or Len(name) == 7)');
    expect(() => translateCondition(u.residual as string, 'span')).not.toThrow();
  });
});
test('textPredicate', () => {
  expect(textPredicate('', 'span')).toBeNull();
  expect(toSql(textPredicate('Foo', 'span') as never)).toBe(
    `(contains(lower(coalesce("name", '')), 'foo') OR contains(lower(coalesce("status_message", '')), 'foo') OR contains(lower(coalesce(CAST("attributes" AS VARCHAR), '')), 'foo') OR contains(lower(coalesce(CAST("resource_attributes" AS VARCHAR), '')), 'foo'))`,
  );
});

describe('translated predicates run in DuckDB with the semantics of compile.ts', () => {
  const rows: [number, string, string | null][] = [
    [
      1,
      '{"http.status_code":500,"s":"a","b":true,"n":null,"d":{"$d":"NaN"},"i":{"$i":"9007199254740993"}}',
      null,
    ],
    [2, '{"http.status_code":200,"s":"5","f":{"$d":"Infinity"}}', null],
    [3, '{"http.status_code":"500"}', 'p'],
    [4, '{}', 'p'],
  ];
  const run = async (conds: [string, number[]][]) => {
    const db = await openTestDb();
    try {
      const values = rows
        .map(([id, a, p]) => `(${id}, 'GET /', 2, '${a}', ${p === null ? 'NULL' : `'${p}'`}, 5, 9, 4)`)
        .join(',');
      db.exec(
        `CREATE TABLE spans AS SELECT * FROM (VALUES ${values}) t(id, name, status_code, attributes, parent_span_id, start_time_unix_nano, end_time_unix_nano, duration_ns)`,
      );
      for (const [src, want] of conds) {
        const t = translateCondition(src, 'span');
        expect(t.residual, src).toBeNull();
        const where = t.predicate === null ? 'TRUE' : toSql(t.predicate);
        const got = db.rows(`SELECT id FROM spans WHERE ${where} ORDER BY id`).map(({ id }) => Number(id));
        expect(got, src).toEqual(want);
      }
    } finally {
      db.close();
    }
  };
  test('attribute comparisons', () =>
    run([
      ['attributes["http.status_code"] >= 500', [1]],
      ['attributes["http.status_code"] != 500', [2, 3, 4]],
      ['attributes["s"] == "5"', [2]],
      ['not (attributes["s"] == "a")', [2, 3, 4]],
      ['attributes["b"] == true', [1]],
      ['attributes["n"] == nil', [1, 2, 3, 4]],
      ['attributes["n"] != nil', []],
      ['attributes["d"] > 1', []],
      ['attributes["d"] != 1', [1, 2, 3, 4]],
      ['attributes["f"] > 1', [2]],
      ['attributes["i"] > 1', [1]],
      ['attributes["s"] == 5', []],
      ['5 < attributes["http.status_code"]', [1, 2]],
    ]));
  test('calls and columns', () =>
    run([
      ['IsInt(attributes["http.status_code"])', [1, 2]],
      ['IsString(attributes["http.status_code"])', [3]],
      ['IsMap(attributes)', [1, 2, 3, 4]],
      ['IsRootSpan()', [1, 2]],
      ['IsMatch(attributes["s"], "^[a5]$")', [1, 2]],
      ['name == 5', []],
      ['name != 5', [1, 2, 3, 4]],
      ['status.code == nil', []],
      ['parent_span_id.string == ""', [1, 2]],
      ['span.end_time_unix_nano - span.start_time_unix_nano == 4', [1, 2, 3, 4]],
      ['start_time_unix_nano < 6', [1, 2, 3, 4]],
    ]));
});

describe('residuals', () => {
  test.each([
    ['span', 'status.code == 1 or Len(name) > 1', 'status.code == 1 or Len(name) > 1'],
    ['span', 'attributes["$x"] == 1', 'attributes["$x"] == 1'],
    ['span', 'attributes["a"]["0"] == 1', 'attributes["a"]["0"] == 1'],
    [
      'span',
      'name == "a" and IsMatch(name, "\\\\s") and Len(name) > 1',
      'IsMatch(name, "\\\\s") and Len(name) > 1',
    ],
    ['span', 'name == attributes["x"]', 'name == attributes["x"]'],
    ['span', 'IsMatch(name, "a{2000}")', 'IsMatch(name, "a{2000}")'],
    ['span', 'IsMatch(name, "[\\\\b]")', 'IsMatch(name, "[\\\\b]")'],
    ['span', `attributes${'["k"]'.repeat(33)} == 1`, `attributes${'["k"]'.repeat(33)} == 1`],
    ['log_record', 'body.string == "x"', 'body.string == "x"'],
    ['log_record', 'IsMatch(body.string, "x")', 'IsMatch(body.string, "x")'],
    ['log_record', 'IsString(body.string)', 'IsString(body.string)'],
  ] as const)('%s: %s', (ctx, src, residual) => {
    expect(translateCondition(src, ctx).residual).toBe(residual);
  });
  test('a condition that does not compile throws as compileCondition does', () => {
    expect(() => translateCondition('nope == 1', 'span')).toThrow(/span path/);
  });
});

test('a log condition runs in DuckDB: absent times read as 0, ids as empty strings', async () => {
  const db = await openTestDb();
  try {
    db.exec(
      `CREATE TABLE logs AS SELECT * FROM (VALUES (1, NULL, NULL, 'a'), (2, 7, 'ab', NULL)) t(id, time_unix_nano, trace_id, event_name)`,
    );
    for (const [src, want] of [
      ['time_unix_nano == 0', [1]],
      ['time_unix_nano > 5', [2]],
      ['trace_id.string == ""', [1]],
      ['event_name == ""', [2]],
    ] as const) {
      const t = translateCondition(src, 'log_record');
      expect(t.predicate).not.toBeNull();
      const where = toSql(t.predicate as never);
      expect(
        db.rows(`SELECT id FROM logs WHERE ${where} ORDER BY id`).map(({ id }) => Number(id)),
        src,
      ).toEqual(want);
    }
  } finally {
    db.close();
  }
});

test('end before start is the signed difference, not the clamped duration_ns', async () => {
  const db = await openTestDb();
  try {
    db.exec(
      `CREATE TABLE spans AS SELECT * FROM (VALUES (1, 5, 3, 0), (2, 5, 9, 4), (3, 5, 5, 0)) t(id, start_time_unix_nano, end_time_unix_nano, duration_ns)`,
    );
    for (const [src, want] of [
      ['span.end_time_unix_nano - span.start_time_unix_nano < 0', [1]],
      ['span.end_time_unix_nano - span.start_time_unix_nano == 0', [3]],
      ['span.end_time_unix_nano - span.start_time_unix_nano >= 0', [2, 3]],
    ] as const) {
      const t = translateCondition(src, 'span');
      const where = toSql(t.predicate as never);
      expect(
        db.rows(`SELECT id FROM spans WHERE ${where} ORDER BY id`).map(({ id }) => Number(id)),
        src,
      ).toEqual(want);
    }
  } finally {
    db.close();
  }
});

describe('size and hints', () => {
  const deep = (n: number) => `attributes${'["k"]'.repeat(n)} == "x"`;
  test('the SQL of a deep path stays linear in its depth and translates up to 32 keys', () => {
    const len = (n: number) => toSql(translateCondition(deep(n), 'span').predicate as never).length;
    expect(len(10)).toBeLessThan(20_000);
    expect(len(32)).toBeLessThan(40_000);
    expect(translateCondition(deep(32), 'span').residual).toBeNull();
    expect(translateCondition(deep(33), 'span').residual).not.toBeNull();
  });
  test('a zero literal hints both zeros', () => {
    const v = (src: string) => [...(translateCondition(src, 'span').hints.get('resource:z') ?? [])].sort();
    expect(v('resource.attributes["z"] == 0')).toEqual(['-0', '0']);
    expect(v('resource.attributes["z"] == -0.0')).toEqual(['-0', '0']);
    expect(v('resource.attributes["z"] == 0.0')).toEqual(['-0', '0']);
    expect(v('resource.attributes["z"] == 7')).toEqual(['7']);
  });
});

describe('Translation.reads', () => {
  const reads = (src: string, ctx: SqlContext = 'span'): ReadonlySet<string> =>
    translateCondition(src, ctx).reads;
  test('a column, a resource key, an attribute key, a whole map', () => {
    expect(reads('name == "a" and resource.attributes["run.id"] == "x"')).toEqual(
      new Set(['name', 'resource:run.id']),
    );
    expect(reads('resource.attributes["service.name"] == "a"')).toEqual(new Set(['service_name']));
    expect(reads('attributes["http.route"] == "/"')).toEqual(new Set(['attr:http.route']));
    expect(reads('IsMap(attributes)')).toEqual(new Set(['attr:*']));
    expect(reads('IsMap(resource.attributes)')).toEqual(new Set(['resource:*']));
    expect(reads('end_time_unix_nano - start_time_unix_nano > 5')).toEqual(
      new Set(['end_time_unix_nano', 'start_time_unix_nano']),
    );
  });
  test('a residual term reads nothing here', () => {
    expect(reads('name == "a" and Len(name) > 1')).toEqual(new Set(['name']));
  });
});
