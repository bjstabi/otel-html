import { describe, expect, test, vi } from 'vitest';
import type { AnyValue } from '../../src/model/anyvalue.js';
import type { RelNanos, SpanId, TraceId, UnixNanos } from '../../src/model/ids.js';
import type {
  LogRecordRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
} from '../../src/model/records.js';
import {
  byTimeThenRef,
  type LogEntry,
  type LogQuery,
  LogQueryRun,
  type LogRef,
  logRef,
  parseLogRef,
  queryLogEntries,
  refParts,
  scanLogEntries,
  toLogEntries,
} from '../../src/viewer/data/log-query.js';
import { DEFAULT_FACET_CAPS, EAGER_BLOCK } from '../../src/viewer/data/query-common.js';
import { medianMs } from '../../test-support/median-ms.js';
import { perfFactor } from '../../test-support/perf-inject.js';

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
const T1 = 'a'.repeat(32) as TraceId;
const T2 = 'b'.repeat(32) as TraceId;
const SPAN = 'c'.repeat(16) as SpanId;
const epoch = 0n as UnixNanos;

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

const entriesOf = (logs: readonly LogRecordRecord[], n = 0): LogEntry[] =>
  toLogEntries({ n, resources, scopes }, logs, epoch, 'test');

/** 6 declined payments (3 in T1), 4 api infos (2 in T2), 2 api warns in T1, 1 debug. */
function fixture(): LogEntry[] {
  const logs: LogRecordRecord[] = [];
  for (let i = 0; i < 6; i++) {
    logs.push(
      log({
        time: ((i + 1) * 1000) as RelNanos,
        severityNumber: 17,
        severityText: 'ERROR',
        body: str(`card declined: ${1000 + i} ${i * 7}`),
        resource: 0 as ResourceRef,
        traceId: i < 3 ? T1 : null,
        spanId: i < 3 ? SPAN : null,
      }),
    );
  }
  for (let i = 0; i < 4; i++) {
    logs.push(
      log({
        time: (7000 + i * 1000) as RelNanos,
        body: str(`GET /items 200 ${i}`),
        traceId: i < 2 ? T2 : null,
      }),
    );
  }
  for (let i = 0; i < 2; i++) {
    logs.push(
      log({
        time: (11_000 + i * 1000) as RelNanos,
        severityNumber: 13,
        severityText: 'WARN',
        body: str('slow upstream'),
        traceId: T1,
      }),
    );
  }
  logs.push(log({ time: 13_000 as RelNanos, severityNumber: 5, body: str('cache hit') }));
  return entriesOf(logs);
}

const base: LogQuery = {
  condition: null,
  text: '',
  window: null,
  mode: 'logs',
  sort: { column: 'time', dir: 'asc' },
  limit: 100,
  scanAll: false,
};

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
    // the tiebreak reads n and i, not the ref string
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

describe('queryLogEntries', () => {
  const entries = fixture();

  test('filters by OTTL in log_record context and by free text', () => {
    const r = queryLogEntries(entries, { ...base, condition: 'log.severity_number >= SEVERITY_NUMBER_WARN' });
    expect(r.mode === 'logs' && r.rows.every((x) => x.log.severityNumber >= 13)).toBe(true);
    expect(r.total).toBe(8);
    expect(queryLogEntries(entries, { ...base, text: 'DECLINED' }).total).toBe(6);
  });

  test('free text also searches severity text and attribute values', () => {
    expect(queryLogEntries(entries, { ...base, text: 'warn' }).total).toBe(2);
    expect(queryLogEntries(entries, { ...base, text: 'h1' }).total).toBe(6);
  });

  test('a span-only path fails fast with invalid-ottl', () => {
    expect(() => queryLogEntries(entries, { ...base, condition: 'span.name == "x"' })).toThrowError(
      /log_record/,
    );
  });

  test('time falls back to observed, then 0, and the source is reported', () => {
    const e = entriesOf([
      log({ time: 500 as RelNanos }),
      log({ time: null, observedTime: 300 as RelNanos }),
      log({ time: null, observedTime: null }),
    ]);
    const r = queryLogEntries(e, base);
    if (r.mode !== 'logs') throw new Error('mode');
    expect(r.rows.map((x) => [x.timeSource, x.time])).toEqual([
      ['none', 0],
      ['observed', 300],
      ['time', 500],
    ]);
    // untimed logs still land in the histogram
    expect(r.buckets.total('info')).toBe(3);
  });

  test('equal times sort by ref, in either direction of the primary column', () => {
    const e = entriesOf([log(), log(), log()], 3).concat(entriesOf([log()], 10));
    for (const dir of ['asc', 'desc'] as const) {
      const r = queryLogEntries(e, { ...base, sort: { column: 'time', dir } });
      if (r.mode !== 'logs') throw new Error('mode');
      expect(r.rows.map((x) => x.ref)).toEqual(['3.0', '3.1', '3.2', '10.0']);
    }
  });

  test('sorts by severity and service with time then ref as tiebreak', () => {
    const sev = queryLogEntries(entries, { ...base, sort: { column: 'severity', dir: 'desc' } });
    if (sev.mode !== 'logs') throw new Error('mode');
    expect(sev.rows.slice(0, 7).map((x) => x.log.severityNumber)).toEqual([17, 17, 17, 17, 17, 17, 13]);
    expect(sev.rows.slice(0, 6).map((x) => x.time)).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    const svc = queryLogEntries(entries, { ...base, sort: { column: 'service', dir: 'asc' } });
    if (svc.mode !== 'logs') throw new Error('mode');
    expect(svc.rows[0]?.service).toBe('api');
  });

  test('limit caps rows but not total', () => {
    const r = queryLogEntries(entries, { ...base, limit: 3 });
    expect(r.rows).toHaveLength(3);
    expect(r.total).toBe(13);
  });

  test('rejects an unknown sort column for the mode and a bad limit', () => {
    expect(() => queryLogEntries(entries, { ...base, sort: { column: 'count', dir: 'asc' } })).toThrowError(
      /query\.sort\.column/,
    );
    expect(() => queryLogEntries(entries, { ...base, limit: -1 })).toThrowError(/query\.limit/);
  });

  test('window keeps logs whose logTime is inside [start, end]', () => {
    const r = queryLogEntries(entries, { ...base, window: { start: 2000, end: 4000 } });
    expect(r.mode === 'logs' && r.rows.map((x) => x.time)).toEqual([2000, 3000, 4000]);
    expect(
      queryLogEntries(entries, { ...base, window: { start: 2000, end: 4000 }, scanAll: true }).total,
    ).toBe(13);
  });

  test('patterns mode clusters only the matched logs', () => {
    const r = queryLogEntries(entries, {
      ...base,
      mode: 'patterns',
      condition: 'resource.attributes["service.name"] == "payments"',
      sort: { column: 'count', dir: 'desc' },
    });
    if (r.mode !== 'patterns') throw new Error('mode');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.template).toBe('card declined: <*> <*>');
    expect(r.rows[0]?.count).toBe(6);
    expect(r.rows[0]?.severities.error).toBe(6);
    expect(r.rows[0]?.sample).toBe('card declined: 1000 0');
    expect([r.rows[0]?.first, r.rows[0]?.last]).toEqual([1000, 6000]);
    expect(r.total).toBe(1);
  });

  test('patterns sort by count, first and last', () => {
    const rows = (column: string, dir: 'asc' | 'desc') => {
      const r = queryLogEntries(entries, { ...base, mode: 'patterns', sort: { column, dir } });
      if (r.mode !== 'patterns') throw new Error('mode');
      return r.rows.map((x) => x.template);
    };
    expect(rows('count', 'desc')[0]).toBe('card declined: <*> <*>');
    expect(rows('first', 'asc')[0]).toBe('card declined: <*> <*>');
    expect(rows('last', 'desc')[0]).toBe('cache hit');
  });

  test('traces mode groups by trace_id and skips logs without one', () => {
    const r = queryLogEntries(entries, {
      ...base,
      mode: 'traces',
      sort: { column: 'logs', dir: 'desc' },
    });
    if (r.mode !== 'traces') throw new Error('mode');
    expect(r.total).toBe(2);
    expect(r.rows).toEqual([
      { traceId: T1, logs: 5, first: 1000, last: 12_000, maxSeverity: 17, services: ['api', 'payments'] },
      { traceId: T2, logs: 2, first: 7000, last: 8000, maxSeverity: 9, services: ['api'] },
    ]);
    const sev = queryLogEntries(entries, {
      ...base,
      mode: 'traces',
      sort: { column: 'severity', dir: 'asc' },
    });
    expect(sev.mode === 'traces' && sev.rows.map((x) => x.traceId)).toEqual([T2, T1]);
  });

  test('traces mode counts only matched logs', () => {
    const r = queryLogEntries(entries, {
      ...base,
      mode: 'traces',
      condition: 'log.severity_number == SEVERITY_NUMBER_WARN',
      sort: { column: 'first', dir: 'asc' },
    });
    if (r.mode !== 'traces') throw new Error('mode');
    expect(r.rows.map((x) => [x.traceId, x.logs, x.services])).toEqual([[T1, 2, ['api']]]);
  });

  test('facets and buckets describe the matched set', () => {
    const r = queryLogEntries(entries, base);
    expect(r.matched).toBe(13);
    const counts = (key: string) => Object.fromEntries(r.facets.top(key, 10).map((v) => [v.value, v.count]));
    expect(counts('severity')).toEqual({ error: 6, info: 4, warn: 2, debug: 1 });
    expect(counts('service.name')).toEqual({ payments: 6, api: 7 });
    expect(r.buckets.total('error')).toBe(6);
    expect(r.buckets.total('warn')).toBe(2);
    expect(r.buckets.total('info')).toBe(4);
    const filtered = queryLogEntries(entries, { ...base, text: 'declined' });
    expect(filtered.matched).toBe(6);
    expect(filtered.facets.top('severity', 10)).toEqual([{ value: 'error', count: 6 }]);
    expect(filtered.buckets.total('info')).toBe(0);
  });

  test('traces mode facets and buckets cover only logs that carry a trace_id', () => {
    const r = queryLogEntries(entries, { ...base, mode: 'traces', sort: { column: 'first', dir: 'asc' } });
    expect(r.matched).toBe(7);
    const counts = Object.fromEntries(r.facets.top('severity', 10).map((v) => [v.value, v.count]));
    expect(counts).toEqual({ error: 3, info: 2, warn: 2 });
    expect(r.facets.top('trace.present', 5)).toEqual([{ value: 'yes', count: 7 }]);
    expect(r.buckets.total('debug')).toBe(0);
  });

  const word = (n: number): string =>
    [n % 26, Math.floor(n / 26) % 26, Math.floor(n / 676)].map((d) => String.fromCharCode(97 + d)).join('');

  test('patterns mode reports unclustered logs once the cluster cap is hit', () => {
    const logs = Array.from({ length: 4000 }, (_, i) =>
      log({ body: str([0, 1, 2, 3].map((k) => word(i * 4 + k)).join(' ')) }),
    );
    const r = queryLogEntries(entriesOf(logs), {
      ...base,
      mode: 'patterns',
      sort: { column: 'count', dir: 'desc' },
      limit: 5000,
    });
    if (r.mode !== 'patterns') throw new Error('mode');
    expect(r.matched).toBe(4000);
    expect(r.unclustered).toBeGreaterThan(0);
    expect(r.rows.reduce((n, p) => n + p.count, 0) + r.unclustered).toBe(4000);
  });

  test('units are matched logs, or matched traces in traces mode', () => {
    const count = (q: LogQuery): number => {
      const run = new LogQueryRun(q, undefined, DEFAULT_FACET_CAPS);
      for (const e of entries) run.visit(e);
      return run.units;
    };
    expect(count(base)).toBe(13);
    expect(count({ ...base, mode: 'patterns', sort: { column: 'count', dir: 'asc' } })).toBe(13);
    expect(count({ ...base, mode: 'traces', sort: { column: 'first', dir: 'asc' } })).toBe(2);
  });

  test('aborts with AbortError', () => {
    const ctl = new AbortController();
    ctl.abort();
    expect(() => queryLogEntries(entries, base, ctl.signal)).toThrowError(
      expect.objectContaining({ name: 'AbortError' }),
    );
  });

  test('an abort from a timer stops an in-memory scan after its first block', async () => {
    vi.stubGlobal('MessageChannel', undefined);
    try {
      const logs = Array.from({ length: EAGER_BLOCK * 4 }, (_, i) =>
        log({ time: i as RelNanos, body: str(`op ${i}`) }),
      );
      let seen = 0;
      const counted = entriesOf(logs).map((e) => ({
        ...e,
        get target() {
          seen++;
          return e.target;
        },
      }));
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 0);
      await expect(
        scanLogEntries(counted, { ...base, condition: 'body == "none"' }, ac.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(seen).toBe(EAGER_BLOCK);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('scanLogEntries lists what queryLogEntries lists', async () => {
    const logs = Array.from({ length: EAGER_BLOCK * 2 + 5 }, (_, i) =>
      log({ time: i as RelNanos, body: str(`op ${i}`) }),
    );
    const e = entriesOf(logs);
    const q = { ...base, condition: 'body == "op 7"' };
    const [a, b] = [await scanLogEntries(e, q), queryLogEntries(e, q)];
    expect([a.rows, a.total, a.matched]).toEqual([b.rows, b.total, b.matched]);
  });

  describe('@perf 200k logs', () => {
    const n = 200_000;
    const logs: LogRecordRecord[] = new Array<LogRecordRecord>(n);
    const bodies = Array.from({ length: 50 }, (_, k) => str(`op${k % 10} finished in step ${k}`));
    for (let i = 0; i < n; i++) {
      logs[i] = log({
        time: (i * 1000) as RelNanos,
        severityNumber: i % 50 === 0 ? 17 : 9,
        body: bodies[i % 50] ?? str(''),
        resource: (i % 2) as ResourceRef,
      });
    }
    const big = entriesOf(logs);

    test('narrow filter (2% match) under 150 ms (median)', () => {
      const q: LogQuery = { ...base, condition: 'log.severity_number >= SEVERITY_NUMBER_ERROR' };
      const { result: r, ms } = medianMs(() => queryLogEntries(big, q));
      expect(r.total).toBe(4000);
      expect(ms).toBeLessThan(150 * perfFactor());
    });

    test('broad filter (98% match) under 150 ms (median)', () => {
      const q: LogQuery = { ...base, condition: 'log.severity_number < SEVERITY_NUMBER_ERROR' };
      const { result: r, ms } = medianMs(() => queryLogEntries(big, q));
      expect(r.total).toBe(196_000);
      expect(ms).toBeLessThan(150 * perfFactor());
    });
  });
});

test('LogRef is a branded string', () => {
  const r: LogRef = logRef(1, 2);
  expect(r).toBe('1.2');
});

describe('LogQueryRun memory', () => {
  test('logs mode holds at most limit plus the compaction slack', () => {
    const logs = Array.from({ length: 10_000 }, (_, i) => log({ time: (i * 10) as RelNanos }));
    const run = new LogQueryRun({ ...base, limit: 1 }, undefined, DEFAULT_FACET_CAPS);
    for (const e of entriesOf(logs)) run.visit(e);
    expect(run.heldRows).toBeLessThanOrEqual(1 + 1024);
    const r = run.finish(null);
    expect(r.total).toBe(10_000);
    expect(r.rows).toHaveLength(1);
    expect(r.mode === 'logs' && r.rows[0]?.time).toBe(0);
  });
});
