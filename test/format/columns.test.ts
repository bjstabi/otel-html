import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  type ColumnarPayload,
  ColumnEncoder,
  type ColumnSpec,
  decodeColumns,
  encodeColumns,
} from '../../src/format/columns.js';
import { wrapDataFile } from '../../src/format/data-file.js';
import { LOG_COLUMNS, METRIC_COLUMNS, SPAN_COLUMNS } from '../../src/format/specs.js';
import type { AnyValue } from '../../src/model/anyvalue.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { parseSpanId, RelNanos, TraceId } from '../../src/model/ids.js';
import type {
  LogRecordRecord,
  MetricPointRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
  SpanRecord,
} from '../../src/model/records.js';
import { realisticSpans, sampleSpans } from '../../test-support/otlp-builders.js';

function viaJson(payload: unknown): unknown {
  return JSON.parse(JSON.stringify(payload));
}

function codeOf(fn: () => unknown): OtelHtmlError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected an OtelHtmlError');
}

describe('column codec', () => {
  test('span columns round-trip exactly', () => {
    const { spans, resources, scopes } = sampleSpans(500);
    const decoded = decodeColumns(
      SPAN_COLUMNS,
      viaJson(encodeColumns(SPAN_COLUMNS, spans, resources, scopes)),
    );
    expect(decoded.rows).toEqual(spans);
    expect(decoded.resources).toEqual(resources);
    expect(decoded.scopes).toEqual(scopes);
  });

  test('int64 beyond 2^53 and negative RelNanos survive a trip through a real data file', () => {
    const { spans, resources, scopes } = sampleSpans(40);
    const text = wrapDataFile('k', encodeColumns(SPAN_COLUMNS, spans, resources, scopes));
    const body = text.slice('__OH__.push("k",'.length, -3);
    const decoded = decodeColumns(SPAN_COLUMNS, JSON.parse(body));
    expect(decoded.rows).toEqual(spans);
    const big = decoded.rows[0]?.attributes.get('k.int.big');
    expect(big).toEqual({ kind: 'int', value: 2n ** 62n });
    expect(decoded.rows.some((r) => r.start < 0)).toBe(true);
    expect(decoded.rows[3]?.start).toBe(-Number.MAX_SAFE_INTEGER);
    expect(decoded.rows[3]?.end).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('double edge cases keep their identity (-0, NaN, whole doubles vs ints)', () => {
    const { spans, resources, scopes } = sampleSpans(3);
    const d = decodeColumns(SPAN_COLUMNS, viaJson(encodeColumns(SPAN_COLUMNS, spans, resources, scopes)));
    const a = d.rows[0]?.attributes ?? new Map<string, AnyValue>();
    const dbl = (k: string): number => {
      const v = a.get(k);
      if (v?.kind !== 'double') throw new Error(`${k} is not a double`);
      return v.value;
    };
    expect(Object.is(dbl('k.double.negzero'), -0)).toBe(true);
    expect(Number.isNaN(dbl('k.double.nan'))).toBe(true);
    expect(dbl('k.double.ninf')).toBe(Number.NEGATIVE_INFINITY);
    expect(a.get('k.double.whole')).toEqual({ kind: 'double', value: 2 });
    expect(a.get('k.int')).toEqual({ kind: 'int', value: -250n });
  });

  test('orphan spans (parent never arrives) round trip with their dangling parent id', () => {
    const { spans, resources, scopes } = sampleSpans(30);
    const ids = new Set(spans.map((s) => s.spanId));
    const orphans = spans.filter((s) => s.parentSpanId !== null && !ids.has(s.parentSpanId));
    expect(orphans.length).toBeGreaterThan(0);
    const d = decodeColumns(SPAN_COLUMNS, viaJson(encodeColumns(SPAN_COLUMNS, spans, resources, scopes)));
    expect(d.rows.filter((s) => s.parentSpanId !== null && !ids.has(s.parentSpanId))).toEqual(orphans);
  });

  test('an empty chunk round trips', () => {
    const d = decodeColumns(SPAN_COLUMNS, viaJson(encodeColumns(SPAN_COLUMNS, [], [], [])));
    expect(d).toEqual({ rows: [], resources: [], scopes: [] });
  });

  test('refs are renumbered per chunk to the resources actually used', () => {
    const { spans, resources, scopes } = sampleSpans(60);
    const tail = spans.filter((s) => s.resource === 2).slice(0, 3);
    const enc = encodeColumns(SPAN_COLUMNS, tail, resources, scopes);
    expect(enc.resources).toHaveLength(1);
    const d = decodeColumns(SPAN_COLUMNS, viaJson(enc));
    expect(d.resources).toEqual([resources[2]]);
    expect(d.scopes).toEqual([scopes[1]]);
    expect(d.rows).toEqual(tail.map((r) => ({ ...r, resource: 0 as ResourceRef, scope: 0 as ScopeRef })));
  });

  test('encode rejects a ref outside the supplied tables', () => {
    const { spans, resources, scopes } = sampleSpans(5);
    expect(() => encodeColumns(SPAN_COLUMNS, spans, resources.slice(0, 1), scopes)).toThrowError(
      /rows\[1\]\.resource/,
    );
  });

  test('a data file built from hostile attribute values is inert', () => {
    const { spans, resources, scopes } = sampleSpans(20);
    const text = wrapDataFile('k', encodeColumns(SPAN_COLUMNS, spans, resources, scopes));
    expect(text).not.toMatch(/<|\u2028|\u2029/);
    const payload = JSON.parse(text.slice('__OH__.push("k",'.length, -3)) as ColumnarPayload;
    expect(payload.dict).toContain('</script><img src=x onerror=alert(1)> \u2028\u2029 "q" \\ \n');
  });

  test('the payload is plain JSON (no bigint / Uint8Array / Map leaks)', () => {
    const { spans, resources, scopes } = sampleSpans(50);
    expect(() => JSON.stringify(encodeColumns(SPAN_COLUMNS, spans, resources, scopes))).not.toThrow();
  });

  test('size budget: <= 300 bytes/span for the realistic fixture', () => {
    const { spans, resources, scopes } = realisticSpans(10_000);
    const p = wrapDataFile('k', encodeColumns(SPAN_COLUMNS, spans, resources, scopes));
    const perSpan = p.length / 10_000;
    expect(perSpan).toBeLessThanOrEqual(300);
    const back = decodeColumns(SPAN_COLUMNS, JSON.parse(p.slice('__OH__.push("k",'.length, -3)));
    expect(back.rows).toEqual(spans);
  });
});

describe('decode validation (invalid-report with precise paths)', () => {
  const { spans, resources, scopes } = sampleSpans(6);
  const good = (): ColumnarPayload =>
    viaJson(encodeColumns(SPAN_COLUMNS, spans, resources, scopes)) as ColumnarPayload;
  /** A good payload with one cell replaced. */
  const withCell = (column: string, row: number, value: unknown): ColumnarPayload => {
    const p = good();
    const cells = [...(p.cols[column] ?? [])];
    cells[row] = value;
    return { ...p, cols: { ...p.cols, [column]: cells } };
  };

  test('decode rejects a malformed payload', () => {
    expect(() => decodeColumns(SPAN_COLUMNS, { v: 2 })).toThrowError(/expected 1/);
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, { v: 2 }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('v');
    expect(codeOf(() => decodeColumns(SPAN_COLUMNS, 'nope')).code).toBe('invalid-report');
  });

  test('missing column', () => {
    const p = good();
    const { spanId: _dropped, ...cols } = p.cols;
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, { ...p, cols }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('cols.spanId');
  });

  test('column length mismatch', () => {
    const p = good();
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, { ...p, cols: { ...p.cols, name: [0] } }));
    expect(e.path).toBe('cols.name');
    expect(e.expected).toContain('6');
  });

  test('bad cell: malformed span id', () => {
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('spanId', 2, 'zz')));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('cols.spanId[2]');
  });

  test('bad cell: dictionary index out of range', () => {
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('name', 4, 99_999)));
    expect(e.path).toBe('cols.name[4]');
    expect(e.expected).toMatch(/dictionary index/);
  });

  test('bad cell: dangling resource ref and corrupt attrs', () => {
    expect(codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('resource', 1, 40))).path).toBe(
      'cols.resource[1]',
    );
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('attributes', 0, [0, [9, 9]])));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toMatch(/^cols\.attributes\[0\]/);
  });

  test('bad json cell', () => {
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('status', 0, 99_999)));
    expect(e.path).toBe('cols.status[0]');
  });

  test('bad resource table entry', () => {
    const e = codeOf(() => decodeColumns(SPAN_COLUMNS, { ...good(), resources: [{ attributes: 'x' }] }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('resources[0].attributes');
  });

  test('bad time cell and non-integer int', () => {
    expect(codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('start', 0, 'soon'))).path).toBe(
      'cols.start[0]',
    );
    expect(codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('flags', 3, 1.5))).path).toBe('cols.flags[3]');
    expect(codeOf(() => decodeColumns(SPAN_COLUMNS, withCell('end', 1, { $i: 'x' }))).path).toBe(
      'cols.end[1]',
    );
  });

  test('encode fails fast on a non-id span id', () => {
    const bad: SpanRecord = {
      ...(spans[0] as SpanRecord),
      spanId: 'nothex' as ReturnType<typeof parseSpanId>,
    };
    expect(codeOf(() => encodeColumns(SPAN_COLUMNS, [bad], resources, scopes)).path).toBe('rows[0].spanId');
  });

  test('encode rejects a non-safe RelNanos', () => {
    const bad: SpanRecord = { ...(spans[0] as SpanRecord), start: (2 ** 60) as RelNanos };
    expect(codeOf(() => encodeColumns(SPAN_COLUMNS, [bad], resources, scopes)).path).toBe('rows[0].start');
  });
});

describe('spec is data', () => {
  test('a custom spec drives the codec', () => {
    interface Row {
      readonly a: string;
      readonly b: number;
      readonly c: boolean;
    }
    const spec: ColumnSpec<Row> = {
      columns: [
        { name: 'a', kind: 'dict' },
        { name: 'b', kind: 'int' },
        { name: 'c', kind: 'bool' },
      ],
    };
    const rows: Row[] = [
      { a: 'x', b: 1, c: true },
      { a: 'x', b: -2, c: false },
    ];
    expect(decodeColumns(spec, viaJson(encodeColumns(spec, rows, [], []))).rows).toEqual(rows);
  });
});

function incrementally<R>(
  spec: ColumnSpec<R>,
  rows: readonly R[],
  resources: readonly ResourceRecord[],
  scopes: readonly ScopeRecord[],
): ColumnarPayload {
  const enc = new ColumnEncoder(spec);
  for (const r of rows) enc.push(r);
  return enc.finish(resources, scopes);
}

/** A payload's serialized bytes, as a data file holds them, by digest. */
const digest = (payload: ColumnarPayload): string =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);

/**
 * Golden digests of the payloads below, recorded from the two-pass encoder `encodeColumns` used before it became a
 * wrapper over `ColumnEncoder`: chunk bytes (dictionary order included) must not change.
 */
const GOLDEN = {
  sample300: 'f51b2c484b81ee70',
  realistic2000: '52edf129ff389a88',
  metrics: '1391734b95abc559',
  logs: 'c97b609ed6415c33',
} as const;

describe('incremental column encoder', () => {
  const str = (value: string): AnyValue => ({ kind: 'string', value });
  const resources: ResourceRecord[] = [
    { attributes: new Map([['service.name', str('a')]]), droppedAttributesCount: 0, schemaUrl: '' },
    {
      attributes: new Map([
        ['service.name', str('b')],
        ['n', str('u0')],
      ]),
      droppedAttributesCount: 1,
      schemaUrl: 's',
    },
  ];
  const scopes: ScopeRecord[] = [
    { name: 'lib', version: '1', attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' },
    {
      name: 'u1',
      version: '2',
      attributes: new Map([['k', str('lib')]]),
      droppedAttributesCount: 0,
      schemaUrl: '',
    },
  ];

  test('span payloads keep their golden bytes, dictionary order included', () => {
    for (const [f, golden] of [
      [sampleSpans(300), GOLDEN.sample300],
      [realisticSpans(2000), GOLDEN.realistic2000],
    ] as const) {
      expect(digest(encodeColumns(SPAN_COLUMNS, f.spans, f.resources, f.scopes))).toBe(golden);
      expect(digest(incrementally(SPAN_COLUMNS, f.spans, f.resources, f.scopes))).toBe(golden);
    }
  });

  test('metric and log payloads keep their golden bytes', () => {
    const points: MetricPointRecord[] = Array.from({ length: 200 }, (_, i) => ({
      name: `m${i % 7}`,
      description: i % 3 === 0 ? 'u1' : '',
      unit: 'ms',
      type: i % 5 === 0 ? 'histogram' : 'sum',
      temporality: i % 2 === 0 ? 'cumulative' : 'delta',
      monotonic: i % 2 === 0,
      start: i % 4 === 0 ? null : ((i * 3) as RelNanos),
      time: ((i % 11) * 1000 - 500) as RelNanos,
      attributes: new Map<string, AnyValue>([
        ['route', str(`/r${i % 13}`)],
        ['n', { kind: 'int', value: BigInt(i) }],
        ['list', { kind: 'array', values: [str('u0'), { kind: 'double', value: i / 3 }] }],
        ['kv', { kind: 'kvlist', values: new Map([['inner', str(`m${i % 2}`)]]) }],
      ]),
      flags: i % 2,
      point:
        i % 5 === 0
          ? { count: String(i), bucketCounts: ['1', '2'], explicitBounds: [1] }
          : { asInt: String(i % 9) },
      resource: (i % 2) as ResourceRef,
      scope: ((i + 1) % 2) as ScopeRef,
    }));
    expect(digest(encodeColumns(METRIC_COLUMNS, points, resources, scopes))).toBe(GOLDEN.metrics);
    expect(digest(incrementally(METRIC_COLUMNS, points, resources, scopes))).toBe(GOLDEN.metrics);
    const logs: LogRecordRecord[] = Array.from({ length: 120 }, (_, i) => ({
      time: i % 3 === 0 ? null : ((i * 7) as RelNanos),
      observedTime: (i * 5) as RelNanos,
      severityNumber: i % 24,
      severityText: i % 2 === 0 ? 'INFO' : 'u1',
      body: i % 4 === 0 ? { kind: 'kvlist', values: new Map([['msg', str(`b${i % 5}`)]]) } : str(`b${i % 6}`),
      attributes: new Map([['k', str(`v${i % 3}`)]]),
      droppedAttributesCount: 0,
      flags: 0,
      traceId: i % 2 === 0 ? null : (`${'0'.repeat(30)}${String(i % 50).padStart(2, '0')}` as TraceId),
      spanId: null,
      eventName: '',
      resource: (1 - (i % 2)) as ResourceRef,
      scope: 0 as ScopeRef,
    }));
    expect(digest(encodeColumns(LOG_COLUMNS, logs, resources, scopes))).toBe(GOLDEN.logs);
    expect(digest(incrementally(LOG_COLUMNS, logs, resources, scopes))).toBe(GOLDEN.logs);
  });

  test('finish leaves the encoder unchanged; a rejected row changes nothing', () => {
    const { spans, resources: rs, scopes: ss } = sampleSpans(20);
    const enc = new ColumnEncoder(SPAN_COLUMNS);
    for (const s of spans.slice(0, 10)) enc.push(s);
    const first = enc.finish(rs, ss);
    expect(enc.finish(rs, ss)).toEqual(first);
    const bad = { ...spans[10], traceId: 'nope' } as unknown as SpanRecord;
    expect(() => enc.push(bad)).toThrowError(/rows\[10\]\.traceId/);
    expect(enc.length).toBe(10);
    for (const s of spans.slice(10)) enc.push(s);
    expect(enc.finish(rs, ss)).toEqual(encodeColumns(SPAN_COLUMNS, spans, rs, ss));
  });

  test('an out-of-range ref is rejected at finish, naming the row', () => {
    const { spans, resources: rs, scopes: ss } = sampleSpans(5);
    const enc = new ColumnEncoder(SPAN_COLUMNS);
    for (const s of spans) enc.push(s);
    expect(() => enc.finish(rs.slice(0, 0), ss)).toThrowError(/rows\[0\]\.resource/);
  });
});
