import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createNormalizeContext,
  type NormalizeContext,
  normalizeLogs,
  normalizeTraces,
} from '../../../src/model/normalize.js';
import type { LogRecordRecord, SpanRecord } from '../../../src/model/records.js';
import { compileCondition } from '../../../src/ottl/compile.js';
import type { LogTarget, SpanTarget } from '../../../src/ottl/contexts.js';
import type { SqlContext } from '../../../src/query/sql/columns.js';
import { toSql, translateCondition } from '../../../src/query/sql/ottl.js';
import type { TestDb } from '../../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../../test-support/format4-fixture.js';
import {
  attr,
  type JsonObject,
  logRecord,
  logsRequest,
  span,
  traceRequest,
} from '../../../test-support/otlp-builders.js';
import { EPOCH_NS, otlp } from '../../../test-support/writer-deps.js';

const hex = (k: number, width: number): string => k.toString(16).padStart(width, '0');
const base = BigInt(EPOCH_NS);
const N = 40;

const str = (key: string, v: string): JsonObject => attr(key, { stringValue: v });
const int = (key: string, v: string): JsonObject => attr(key, { intValue: v });

/** Attributes covering every value kind, varying with the row index. */
function attrs(i: number): JsonObject[] {
  const out: JsonObject[] = [];
  if (i % 3 !== 2) out.push(str('a/b', i % 3 === 0 ? 'x' : 'y'));
  if (i % 4 !== 3) out.push(str('q"x', i % 2 === 0 ? 'quoted' : 'other'));
  if (i % 3 === 1) out.push(int('$weird', String(i)));
  out.push(
    int(
      'n',
      ['9007199254740993', '9007199254740992', '5', '-9007199254740993', '9223372036854775807'][
        i % 5
      ] as string,
    ),
  );
  const d = [
    { doubleValue: 3 },
    { doubleValue: 3.5 },
    { intValue: '3' },
    { stringValue: '3' },
    { doubleValue: -0.5 },
  ];
  out.push(attr('d', d[i % 5] as JsonObject));
  if (i % 5 === 0) out.push(attr('nan', { doubleValue: 'NaN' }));
  out.push(attr('b', { boolValue: i % 2 === 0 }));
  if (i % 6 === 0) out.push(attr('m', { kvlistValue: { values: [str('k', 'v'), int('j', '1')] } }));
  else if (i % 6 === 1) out.push(attr('m', { kvlistValue: { values: [str('k', 'w')] } }));
  else if (i % 6 === 2) out.push(str('m', 'plain'));
  if (i % 4 === 0)
    out.push(attr('arr', { arrayValue: { values: [{ stringValue: 'a' }, { intValue: '2' }] } }));
  if (i % 7 === 0) out.push(attr('by', { bytesValue: 'AQID' }));
  if (i % 5 === 1) out.push(str('e', ''));
  if (i % 8 === 0) {
    // the depth-3 map in plain and pairs form, at the middle and the top level, a string, and a duplicate key
    // (the normalizer keeps the last, so no pair list ever repeats a key)
    const x7 = int('x', '7');
    const variant = i / 8;
    const deep = (values: JsonObject[]): JsonObject => attr('deep', { kvlistValue: { values } });
    const nested = (values: JsonObject[]): JsonObject => attr('nested', { kvlistValue: { values } });
    if (variant === 0) out.push(nested([deep([x7])]));
    else if (variant === 1) out.push(nested([deep([int('$k', '1'), x7])]));
    else if (variant === 2) out.push(nested([int('$t', '1'), deep([x7])]));
    else if (variant === 3) out.push(nested([deep([str('x', '7')])]));
    else out.push(nested([deep([x7, int('x', '8')])]));
  }
  out.push(
    i % 3 === 0
      ? int('http.status_code', i % 2 === 0 ? '500' : '200')
      : str('http.status_code', i % 2 === 0 ? '500' : 'ok'),
  );
  out.push(str('s', ['5', 'a', 'err x', ''][i % 4] as string));
  return out;
}

function spanRequests(): JsonObject[] {
  const mk = (from: number, to: number, svc: string): JsonObject => {
    const spans: JsonObject[] = [];
    for (let i = from; i < to; i++) {
      spans.push(
        span({
          traceId: hex(1 + (i % 5), 32),
          spanId: hex(i + 1, 16),
          ...(i % 3 === 0 ? {} : { parentSpanId: hex(100 + i, 16) }),
          name: ['GET /', 'POST /x', 'op', 'GET /y'][i % 4] as string,
          kind: (i % 5) + 1,
          startTimeUnixNano: String(base + BigInt(i) * 1000n),
          // some spans end before they start: the signed difference
          endTimeUnixNano: String(base + BigInt(i) * 1000n + (i % 7 === 0 ? -300n : BigInt(i) * 100_000n)),
          status: { code: i % 3, ...(i % 3 === 2 ? { message: 'boom' } : {}) },
          attributes: attrs(i),
        }),
      );
    }
    return traceRequest(spans, [str('service.name', svc), int('cicd.pipeline.run.id', '42')]);
  };
  return [mk(0, N / 2, 'web'), mk(N / 2, N, 'api')];
}

function logRequests(): JsonObject[] {
  const mk = (from: number, to: number, svc: string): JsonObject => {
    const recs: JsonObject[] = [];
    for (let i = from; i < to; i++) {
      const body = [
        { stringValue: 'plain' },
        { stringValue: 'error: bad' },
        { kvlistValue: { values: [str('k', 'v')] } },
        { intValue: String(i) },
      ][i % 4] as JsonObject;
      recs.push(
        logRecord({
          timeUnixNano: i % 5 === 0 ? '0' : String(base + BigInt(i) * 1000n),
          observedTimeUnixNano: String(base + BigInt(i) * 1000n + 7n),
          severityNumber: [1, 5, 9, 13, 17, 21][i % 6] as number,
          severityText: ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', ''][i % 6] as string,
          body,
          ...(i % 3 === 0 ? {} : { traceId: hex(1 + (i % 5), 32) }),
          ...(i % 4 === 0 ? {} : { spanId: hex(i + 1, 16) }),
          attributes: attrs(i),
        }),
      );
    }
    return logsRequest(recs, [str('service.name', svc)]);
  };
  return [mk(0, N / 2, 'web'), mk(N / 2, N, 'api')];
}

const spanConditions = [
  'name == "GET /"',
  'status.code == STATUS_CODE_ERROR',
  'attributes["http.status_code"] >= 500',
  'resource.attributes["service.name"] == "web" and IsMatch(name, "^GET")',
  'span.end_time_unix_nano - span.start_time_unix_nano > 1000000',
  'span.end_time_unix_nano - span.start_time_unix_nano < 0',
  'IsRootSpan()',
  'attributes["http.status_code"] != 500',
  'attributes["s"] == "5"',
  'not (attributes["s"] == "a")',
  'attributes["b"] == true',
  'attributes["n"] == nil',
  'attributes["n"] != nil',
  'attributes["missing"] == nil',
  'attributes["d"] > 1',
  'attributes["d"] != 1',
  'attributes["nan"] > 1',
  'attributes["f"] > 1',
  'attributes["s"] == 5',
  '5 < attributes["http.status_code"]',
  'IsInt(attributes["http.status_code"])',
  'IsString(attributes["http.status_code"])',
  'IsMap(attributes)',
  'IsMatch(attributes["s"], "^[a5]$")',
  'name == 5',
  'name != 5',
  'status.code == nil',
  'parent_span_id.string == ""',
  'start_time_unix_nano < 6',
  'attributes["a/b"] == "x"',
  'attributes["q\\"x"] == "quoted"',
  'attributes["$weird"] == 4',
  'attributes["n"] == 9007199254740993',
  'attributes["n"] > 9007199254740992',
  'attributes["n"] == -9007199254740993',
  'attributes["n"] == 5',
  'attributes["d"] == 3',
  'attributes["d"] == 3.5',
  'attributes["d"] < 0',
  'attributes["b"] == false',
  'attributes["m"]["k"] == "v"',
  'attributes["m"]["k"] == nil',
  'attributes["nested"]["deep"]["x"] == 7',
  'attributes["nested"]["deep"]["x"] == nil',
  'attributes["nested"]["deep"]["x"] == "7"',
  'attributes["nested"]["deep"]["x"] == 8',
  'attributes["nested"]["deep"]["x"] > 7',
  'IsInt(attributes["nested"]["deep"]["x"])',
  'IsMap(attributes["nested"]["deep"])',
  'IsMap(attributes["m"])',
  'IsMap(attributes["arr"])',
  'attributes["arr"] == nil',
  'attributes["by"] != nil',
  'attributes["e"] == ""',
  'IsString(attributes["e"])',
  'kind == SPAN_KIND_SERVER or kind == 4',
  'name == "GET /" and attributes["b"] == true',
  'name == "op" or attributes["a/b"] == "y"',
  'not IsRootSpan()',
  'resource.attributes["cicd.pipeline.run.id"] == 42',
  'resource.attributes["service.name"] == "api"',
  'trace_id.string == "00000000000000000000000000000001"',
  'status.message == "boom"',
  'Len(name) > 3',
  'IsMatch(name, "err.*") or status.code == 1',
];
const logConditions = [
  'log.severity_number >= SEVERITY_NUMBER_WARN and Len(body) > 3',
  'trace_id.string == ""',
  'severity_text == "WARN"',
  'severity_number >= 13',
  'severity_number == SEVERITY_NUMBER_ERROR',
  'IsMatch(body.string, "err.*")',
  'body.string == "plain"',
  'IsString(body.string)',
  'IsMap(body)',
  'body == nil',
  'Len(body) > 3',
  'time_unix_nano == 0',
  'time_unix_nano > 5',
  'observed_time_unix_nano > time_unix_nano',
  'event_name == ""',
  'span_id.string == ""',
  'attributes["n"] == 9007199254740993',
  'attributes["d"] == 3.5',
  'attributes["m"]["k"] == "v"',
  'attributes["missing"] == nil',
  'attributes["a/b"] == "x" and severity_number > 5',
  'resource.attributes["service.name"] == "web"',
  'severity_text == "" or attributes["b"] == true',
];

/**
 * Conditions that must stay (partly) in the browser: a number beyond 2^53, `$`-prefixed keys, `body.string`, `Len`, and
 * a time column compared with another path. Everything else must translate completely.
 */
const RESIDUAL = new Set([
  'span:attributes["$weird"] == 4',
  'span:attributes["n"] == 9007199254740993',
  'span:attributes["n"] > 9007199254740992',
  'span:attributes["n"] == -9007199254740993',
  'span:Len(name) > 3',
  'log_record:log.severity_number >= SEVERITY_NUMBER_WARN and Len(body) > 3',
  'log_record:IsMatch(body.string, "err.*")',
  'log_record:body.string == "plain"',
  'log_record:IsString(body.string)',
  'log_record:Len(body) > 3',
  'log_record:observed_time_unix_nano > time_unix_nano',
  'log_record:attributes["n"] == 9007199254740993',
]);
/** Conditions whose result is legitimately empty or all rows on this fixture (every other one must select some rows, not all). */
const TRIVIAL = new Set([
  'span:attributes["n"] == nil',
  'span:attributes["n"] != nil',
  'span:attributes["missing"] == nil',
  'span:attributes["d"] != 1',
  'span:attributes["nan"] > 1',
  'span:attributes["f"] > 1',
  'span:attributes["s"] == 5',
  'span:IsMap(attributes)',
  'span:name == 5',
  'span:name != 5',
  'span:status.code == nil',
  'span:start_time_unix_nano < 6',
  'span:IsMap(attributes["arr"])',
  'span:resource.attributes["cicd.pipeline.run.id"] == 42',
  'log_record:IsString(body.string)',
  'log_record:body == nil',
  'log_record:observed_time_unix_nano > time_unix_nano',
  'log_record:event_name == ""',
  'log_record:attributes["missing"] == nil',
]);

describe('SQL and browser evaluation agree on the translatable OTTL subset', () => {
  let fixture: Format4Fixture;
  let db: TestDb;
  let spanRecords: SpanRecord[];
  let logRecords: LogRecordRecord[];
  let ctx: NormalizeContext;

  beforeAll(async () => {
    const reqs = [...spanRequests(), ...logRequests()].map((r) => otlp(r));
    fixture = await buildFormat4Report(reqs, { close: false });
    db = await openFixtureDb(fixture);
    ctx = createNormalizeContext(fixture.epoch as never);
    spanRecords = [];
    logRecords = [];
    for (const r of reqs) {
      if (r.signal === 'traces') spanRecords.push(...normalizeTraces(r.request, ctx, 'fx'));
      else if (r.signal === 'logs') logRecords.push(...normalizeLogs(r.request, ctx, 'fx'));
    }
    expect(spanRecords).toHaveLength(N);
    expect(logRecords).toHaveLength(N);
  });
  afterAll(() => db.close());

  const epoch = () => fixture.epoch as never;
  const spanTarget = (s: SpanRecord): SpanTarget => ({
    span: s,
    resource: ctx.resources.get(s.resource),
    scope: ctx.scopes.get(s.scope),
    epoch: epoch(),
  });
  const logTarget = (l: LogRecordRecord): LogTarget => ({
    log: l,
    resource: ctx.resources.get(l.resource),
    scope: ctx.scopes.get(l.scope),
    epoch: epoch(),
  });
  // a log's index travels in its (unique) observed time: a JSON attribute would move with the `$m` form
  const lid = (l: LogRecordRecord): number => (Number(l.observedTime) - 7) / 1000;

  function check(
    src: string,
    context: SqlContext,
    jsIds: (src: string) => Set<number>,
    sqlIds: (where: string) => number[],
    residualIds: (residual: string, ids: Set<number>) => Set<number>,
  ) {
    const expected = jsIds(src);
    const t = translateCondition(src, context);
    const label = `${context}:${src}`;
    expect(t.residual !== null, `${label}: residual-ness`).toBe(RESIDUAL.has(label));
    if (t.residual === null) expect(t.predicate, label).not.toBeNull();
    if (TRIVIAL.has(label)) expect([0, N], label).toContain(expected.size);
    else {
      expect(expected.size, `${label}: empty expected set`).toBeGreaterThan(0);
      expect(expected.size, `${label}: expected set is every row`).toBeLessThan(N);
    }
    const where = t.predicate === null ? 'TRUE' : toSql(t.predicate);
    const got = new Set(sqlIds(where));
    if (t.residual === null) {
      expect(
        [...got].sort((a, b) => a - b),
        src,
      ).toEqual([...expected].sort((a, b) => a - b));
    } else {
      for (const id of expected) expect(got.has(id), `${src}: SQL lost row ${id}`).toBe(true);
      const rechecked = residualIds(t.residual, got);
      expect(
        [...rechecked].sort((a, b) => a - b),
        src,
      ).toEqual([...expected].sort((a, b) => a - b));
    }
  }

  test.each(spanConditions)('span: %s', (src) => {
    const byId = new Map(spanRecords.map((s, i) => [i, s]));
    const key = new Map(spanRecords.map((s, i) => [s.spanId as string, i]));
    check(
      src,
      'span',
      (c) => {
        const cond = compileCondition(c, 'span');
        return new Set([...byId].filter(([, s]) => cond.test(spanTarget(s))).map(([i]) => i));
      },
      (where) =>
        db
          .rows(`SELECT span_id FROM spans WHERE ${where}`)
          .map((r) => key.get(String(Object.entries(r).find(([k]) => k === 'span_id')?.[1])) as number),
      (residual, ids) => {
        const cond = compileCondition(residual, 'span');
        return new Set([...ids].filter((i) => cond.test(spanTarget(byId.get(i) as SpanRecord))));
      },
    );
  });

  test.each(logConditions)('log: %s', (src) => {
    const byId = new Map(logRecords.map((l) => [lid(l), l]));
    check(
      src,
      'log_record',
      (c) => {
        const cond = compileCondition(c, 'log_record');
        return new Set([...byId].filter(([, l]) => cond.test(logTarget(l))).map(([i]) => i));
      },
      (where) =>
        db
          .rows(
            `SELECT CAST((observed_time_unix_nano - ${fixture.epoch}::BIGINT - 7) / 1000 AS BIGINT) AS lid FROM logs WHERE ${where}`,
          )
          .map((r) => Number(Object.entries(r).find(([k]) => k === 'lid')?.[1])),
      (residual, ids) => {
        const cond = compileCondition(residual, 'log_record');
        return new Set([...ids].filter((i) => cond.test(logTarget(byId.get(i) as LogRecordRecord))));
      },
    );
  });
});
