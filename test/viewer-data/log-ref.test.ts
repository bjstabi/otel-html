import { describe, expect, test } from 'vitest';
import type { AnyValue } from '../../src/model/anyvalue.js';
import type { RelNanos, UnixNanos } from '../../src/model/ids.js';
import type {
  LogRecordRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
} from '../../src/model/records.js';
import {
  byTimeThenRef,
  type LogRef,
  logRef,
  parseLogRef,
  refParts,
  toLogEntries,
} from '../../src/viewer/data/log-query.js';

const str = (value: string): AnyValue => ({ kind: 'string', value });
const resource = (service: string, host?: string): ResourceRecord => ({
  attributes: new Map([
    ['service.name', str(service)],
    ...(host === undefined ? [] : ([['host.name', str(host)]] as const)),
  ]),
  droppedAttributesCount: 0,
  schemaUrl: '',
});
const resources: ResourceRecord[] = [resource('payments', 'h1'), resource('api')];
const scopes: ScopeRecord[] = [
  { name: 'scope', version: '', attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' },
];

function log(over: Partial<LogRecordRecord> = {}): LogRecordRecord {
  return {
    time: 1000 as RelNanos,
    observedTime: null,
    severityNumber: 9,
    severityText: 'INFO',
    body: str('hello'),
    attributes: new Map(),
    droppedAttributesCount: 0,
    flags: 0,
    traceId: null,
    spanId: null,
    eventName: '',
    resource: 1 as ResourceRef,
    scope: 0 as ScopeRef,
    ...over,
  };
}

const entriesOf = (logs: LogRecordRecord[], n = 0): ReturnType<typeof toLogEntries> =>
  toLogEntries({ n, resources, scopes }, logs, 0n as UnixNanos, 'test');

describe('log refs', () => {
  test('round trip', () => {
    expect(refParts(logRef(12, 345))).toEqual({ n: 12, i: 345 });
    expect(parseLogRef('12.345', 'url.log')).toBe('12.345');
  });
  test.each(['', '12', '12.', '.3', 'a.b', '1.2.3', '-1.2', '01.2x'])('rejects %j', (s) => {
    expect(() => parseLogRef(s, 'url.log')).toThrowError(/url\.log/);
  });
  test('toLogEntries assigns <partition>.<row> refs', () => {
    const e = entriesOf([log(), log()], 7);
    expect(e.map((x) => x.row.ref)).toEqual(['7.0', '7.1']);
  });
  test('rows carry the ref parts, and the time tiebreak compares them numerically', () => {
    const rows = entriesOf(
      Array.from({ length: 11 }, () => log()),
      3,
    ).map((e) => e.row);
    expect(rows.map((r) => [r.n, r.i])).toEqual(rows.map((r) => [refParts(r.ref).n, refParts(r.ref).i]));
    const [r9, r10] = [rows[9], rows[10]];
    if (r9 === undefined || r10 === undefined) throw new Error('rows');
    expect(byTimeThenRef(r9, r10)).toBeLessThan(0); // 3.9 before 3.10
    expect(byTimeThenRef(r10, { ...r9, ref: '0.0' as LogRef })).toBeGreaterThan(0);
  });
  test('toLogEntries fails fast on a dangling resource or scope ref', () => {
    expect(() => entriesOf([log({ resource: 9 as ResourceRef })])).toThrowError(/test\[0\]/);
    expect(() => entriesOf([log({ scope: 4 as ScopeRef })])).toThrowError(/test\[0\]/);
  });
  test('rows carry service and host', () => {
    const [a, b] = entriesOf([log({ resource: 0 as ResourceRef }), log()]);
    expect([a?.row.service, a?.row.host, b?.row.service, b?.row.host]).toEqual([
      'payments',
      'h1',
      'api',
      null,
    ]);
  });
});
