import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { parseUnixNanos } from '../../src/model/ids.js';
import { createNormalizeContext, earliestTimestamp, normalizeMetrics } from '../../src/model/normalize.js';
import {
  decodeRequest,
  type OtlpRequest,
  parseJsonText,
  requestOf,
  type SignalEntry,
  signalEntry,
} from '../../src/model/otlp-json.js';
import { metricPointsOf, plainMetrics } from '../../src/model/otlp-json-metrics.js';
import { T0 } from '../../test-support/otlp-builders.js';

// The protobuf-free metrics path (otlp-json-metrics.ts) against protobuf-es: for every input, the records (with
// their resources and scopes), the epoch candidate and any rejection must be exactly those of `decodeRequest` +
// `normalizeMetrics`. Inputs it does not read must fall back, so their rejections are protobuf-es's own.

const SOURCE = 'f.json';
const epoch = parseUnixNanos(T0, 'epoch');
const T1 = '1700000000010000000';

function metricsEntry(): SignalEntry {
  const e = signalEntry('resourceMetrics');
  if (e === undefined) throw new Error('no metrics entry');
  return e;
}

/** Exact text of a value: key order, -0, bigint and Map entries included. */
function exact(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === 'bigint') return `${x}n`;
    if (typeof x === 'number' && Object.is(x, -0)) return '-0';
    if (x instanceof Map) return { map: [...x.entries()] };
    if (x instanceof Uint8Array) return { bytes: [...x] };
    return x;
  });
}

function errorOf(e: unknown): string {
  if (!(e instanceof OtelHtmlError)) throw e;
  return exact({ code: e.code, message: e.message, path: e.path, expected: e.expected, actual: e.actual });
}

type Outcome = { readonly plain: boolean; readonly text: string };

/** Records, resources, scopes and earliest time of one request, or its error. */
function outcome(items: readonly unknown[], first: number, decode: boolean): Outcome {
  const ctx = createNormalizeContext(epoch);
  let req: OtlpRequest;
  try {
    req = decode
      ? decodeRequest(metricsEntry(), items, first, SOURCE)
      : requestOf(metricsEntry(), items, first, SOURCE);
  } catch (e) {
    return { plain: false, text: errorOf(e) };
  }
  if (req.signal !== 'metrics') throw new Error('not metrics');
  const plain = req.plain !== undefined;
  try {
    const earliest = earliestTimestamp(req);
    const records = decode
      ? normalizeMetrics(req.request, ctx, SOURCE, first)
      : [...metricPointsOf(req, ctx, SOURCE)];
    // the second walk (the session checks, then applies) yields the same records
    const again = decode ? [] : [...metricPointsOf(req, createNormalizeContext(epoch), SOURCE)];
    if (!decode) expect(exact(again)).toBe(exact(records));
    return {
      plain,
      text: exact({
        earliest,
        records,
        resources: ctx.resources.entries(),
        scopes: ctx.scopes.entries(),
      }),
    };
  } catch (e) {
    return { plain, text: errorOf(e) };
  }
}

/** Asserts parity and returns whether the plain path read the input. */
function parity(items: readonly unknown[], first = 0): boolean {
  const slow = outcome(items, first, true);
  const fast = outcome(items, first, false);
  expect(fast.text).toBe(slow.text);
  return fast.plain;
}

const pt = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  attributes: [
    { key: 'host', value: { stringValue: 'h-1' } },
    { key: 'n', value: { intValue: '42' } },
  ],
  startTimeUnixNano: T0,
  timeUnixNano: T1,
  asInt: '7',
  ...o,
});

/** A point without `asInt`, plus `o`. */
function valueless(o: Record<string, unknown> = {}): Record<string, unknown> {
  const { asInt: _, ...rest } = pt(o);
  return rest;
}

function resourceMetrics(metrics: readonly unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
    scopeMetrics: [{ scope: { name: 'sc', version: '1' }, metrics }],
    ...extra,
  };
}

const sum = (dataPoints: readonly unknown[], o: Record<string, unknown> = {}): unknown => ({
  name: 'requests',
  description: 'd',
  unit: '1',
  sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints },
  ...o,
});
const gauge = (dataPoints: readonly unknown[], o: Record<string, unknown> = {}): unknown => ({
  name: 'temp',
  unit: 'Cel',
  gauge: { dataPoints },
  ...o,
});

/** Inputs the plain path reads. */
const READ: readonly [string, readonly unknown[]][] = [
  ['the load-test shape', [resourceMetrics([sum([pt(), pt({ asInt: '9' })]), gauge([pt({ asInt: '3' })])])]],
  [
    'every scalar and nested attribute value',
    [
      resourceMetrics([
        gauge([
          pt({
            attributes: [
              { key: 's', value: { stringValue: 'é ☃ 😀' } },
              { key: 'b', value: { boolValue: false } },
              { key: 'i', value: { intValue: -9007199254740991 } },
              { key: 'i2', value: { intValue: '-9223372036854775808' } },
              { key: 'd', value: { doubleValue: -0 } },
              { key: 'd2', value: { doubleValue: 1.5e300 } },
              { key: 'a', value: { arrayValue: { values: [{ intValue: 1 }, {}, { stringValue: 'x' }] } } },
              { key: 'a0', value: { arrayValue: {} } },
              { key: 'k', value: { kvlistValue: { values: [{ key: 'z', value: { boolValue: true } }] } } },
              { key: 'k0', value: { kvlistValue: {} } },
              { key: 'e', value: {} },
              { key: 'none' },
              { value: { stringValue: 'no key' } },
              { key: 's', value: { stringValue: 'duplicate key, last wins' } },
            ],
          }),
        ]),
      ]),
    ],
  ],
  [
    'value forms',
    [
      resourceMetrics([
        gauge([
          pt({ asInt: 5 }),
          pt({ asInt: -0 }),
          pt({ asInt: '007' }),
          pt({ asInt: '-0' }),
          pt({ asInt: '9223372036854775807' }),
          pt({ asInt: '-9223372036854775808' }),
          valueless(),
          valueless({ asDouble: 2.5 }),
          valueless({ asDouble: -0 }),
          valueless({ asDouble: 0 }),
          pt({ startTimeUnixNano: '0' }),
          pt({ flags: 1 }),
          pt({ flags: -0 }),
          pt({ flags: 4294967295 }),
          pt({ exemplars: [] }),
        ]),
      ]),
    ],
  ],
  [
    'temporality by number and name, monotonic, defaults',
    [
      resourceMetrics([
        sum([pt()], { sum: { aggregationTemporality: 1, dataPoints: [pt()] } }),
        sum([pt()], { sum: { aggregationTemporality: 'AGGREGATION_TEMPORALITY_DELTA', dataPoints: [pt()] } }),
        sum([pt()], {
          sum: {
            aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
            isMonotonic: false,
            dataPoints: [],
          },
        }),
        sum([pt()], { sum: { aggregationTemporality: 0, dataPoints: [pt()] } }),
        sum([pt()], { sum: { dataPoints: [pt()] } }),
        { name: 'no data' },
        { name: 'empty gauge', gauge: {} },
        {},
      ]),
    ],
  ],
  [
    'resources, scopes and schema URLs',
    [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'a' } }],
          droppedAttributesCount: 3,
        },
        schemaUrl: 'https://opentelemetry.io/schemas/1.26.0',
        scopeMetrics: [
          {
            scope: { name: 'x', version: '2', attributes: [{ key: 'q', value: { stringValue: 'r' } }] },
            schemaUrl: 'https://s',
            metrics: [gauge([pt()])],
          },
          { scope: { droppedAttributesCount: 1 }, metrics: [gauge([pt()])] },
          { metrics: [gauge([pt()])] },
          {},
        ],
      },
      { scopeMetrics: [{ metrics: [gauge([pt()])] }] },
      {},
    ],
  ],
  ['no resource entries', []],
  ['a point without a time (a record-time error)', [resourceMetrics([gauge([pt(), {}])])]],
  [
    'a point time as a small number (a record-time error)',
    [resourceMetrics([gauge([pt({ timeUnixNano: 1700000000000000 })])])],
  ],
  [
    'a start time outside the epoch window (a record-time error)',
    [resourceMetrics([sum([pt({ startTimeUnixNano: '1' })])])],
  ],
  [
    'a time beyond int64 nanoseconds (a record-time error)',
    [resourceMetrics([gauge([pt({ timeUnixNano: '18446744073709551615' })])])],
  ],
];

describe('plain metrics path', () => {
  for (const [name, items] of READ) {
    test(`reads ${name} exactly as protobuf-es`, () => {
      expect(parity(items)).toBe(true);
      expect(parity(items, 5)).toBe(true);
      // the cases named as errors fail while reading records; the others give records
      expect(outcome(items, 0, false).text.startsWith('{"earliest"')).toBe(!name.includes('error'));
    });
  }

  test('reads int64 source text from parsed JSON text (numbers beyond 2^53) exactly as protobuf-es', () => {
    const text = `{"resource":{},"scopeMetrics":[{"metrics":[{"name":"g","gauge":{"dataPoints":[{"timeUnixNano":1700000000000000005,"startTimeUnixNano":1700000000000000001,"asInt":-9007199254740997,"attributes":[{"key":"i","value":{"intValue":9007199254740993}},{"key":"d","value":{"doubleValue":100000000000000000000}}]},{"timeUnixNano":1700000000000000009,"asDouble":100000000000000000000}]}}]}]}`;
    expect(parity([parseJsonText(text, SOURCE)])).toBe(true);
  });

  /** Mutations of one field of a point, a metric, a scope or a resource; none may change any outcome. */
  const VALUES: readonly unknown[] = [
    null,
    '',
    'x',
    ' 5',
    '5 ',
    '5.0',
    '0x10',
    '1e3',
    '+5',
    '-1',
    '18446744073709551616',
    '-9223372036854775809',
    '9223372036854775808',
    'NaN',
    'Infinity',
    '\ud800',
    -1,
    1.5,
    -0,
    2 ** 53 + 2,
    2 ** 32,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    [],
    [1],
    {},
    { stringValue: 'x' },
  ];
  const POINT_FIELDS = [
    'timeUnixNano',
    'startTimeUnixNano',
    'asInt',
    'asDouble',
    'flags',
    'attributes',
    'exemplars',
    'time_unix_nano',
    'as_int',
    'unknownField',
  ];

  test('every hostile point field value gives the protobuf-es records or rejection', () => {
    let read = 0;
    let fellBack = 0;
    for (const k of POINT_FIELDS) {
      for (const v of VALUES) {
        const p = k === 'asDouble' ? valueless({ [k]: v }) : pt({ [k]: v });
        if (parity([resourceMetrics([sum([p])])])) read++;
        else fellBack++;
      }
    }
    expect(read).toBeGreaterThan(5);
    expect(fellBack).toBeGreaterThan(100);
  });

  test('every hostile attribute, metric, scope and resource value gives the protobuf-es outcome', () => {
    const shapes: ((v: unknown) => unknown)[] = [
      (v) => resourceMetrics([gauge([pt({ attributes: [{ key: v, value: { stringValue: 'x' } }] })])]),
      (v) => resourceMetrics([gauge([pt({ attributes: [{ key: 'k', value: v }] })])]),
      ...[
        'stringValue',
        'boolValue',
        'intValue',
        'doubleValue',
        'arrayValue',
        'kvlistValue',
        'bytesValue',
      ].map(
        (kind) => (v: unknown) =>
          resourceMetrics([gauge([pt({ attributes: [{ key: 'k', value: { [kind]: v } }] })])]),
      ),
      (v) =>
        resourceMetrics([
          gauge([pt({ attributes: [{ key: 'k', value: { arrayValue: { values: [v] } } }] })]),
        ]),
      (v) =>
        resourceMetrics([
          gauge([pt({ attributes: [{ key: 'k', value: { kvlistValue: { values: [v] } } }] })]),
        ]),
      (v) => resourceMetrics([gauge([pt({ attributes: [v] })])]),
      (v) =>
        resourceMetrics([
          gauge([pt({ attributes: [{ key: 'k', value: { stringValue: 'x', boolValue: v } }] })]),
        ]),
      ...['name', 'description', 'unit', 'gauge', 'sum', 'histogram', 'metadata', 'extra'].map(
        (k) => (v: unknown) => resourceMetrics([gauge([pt()], { [k]: v })]),
      ),
      ...['aggregationTemporality', 'isMonotonic', 'dataPoints', 'aggregation_temporality'].map(
        (k) => (v: unknown) =>
          resourceMetrics([sum([pt()], { sum: { aggregationTemporality: 2, dataPoints: [pt()], [k]: v } })]),
      ),
      (v) => resourceMetrics([gauge([pt()], { gauge: { dataPoints: [pt(), v] } })]),
      (v) => resourceMetrics([v]),
      ...['name', 'version', 'attributes', 'droppedAttributesCount', 'extra'].map((k) => (v: unknown) => ({
        scopeMetrics: [{ scope: { [k]: v }, metrics: [gauge([pt()])] }],
      })),
      ...['scope', 'metrics', 'schemaUrl', 'schema_url'].map((k) => (v: unknown) => ({
        scopeMetrics: [{ metrics: [gauge([pt()])], [k]: v }],
      })),
      ...['attributes', 'droppedAttributesCount', 'entityRefs', 'name'].map((k) => (v: unknown) => ({
        resource: { [k]: v },
        scopeMetrics: [{ metrics: [gauge([pt()])] }],
      })),
      ...['resource', 'scopeMetrics', 'schemaUrl', 'scope_metrics'].map((k) => (v: unknown) => ({
        scopeMetrics: [{ metrics: [gauge([pt()])] }],
        [k]: v,
      })),
    ];
    let read = 0;
    for (const shape of shapes) {
      for (const v of VALUES) if (parity([shape(v)])) read++;
      parity([shape(undefined)].map((r) => JSON.parse(JSON.stringify(r)))); // the field left out
    }
    expect(read).toBeGreaterThan(30);
    // a non-object resource entry
    for (const v of VALUES) parity([v]);
  });

  test('temporality values protobuf-es accepts but the plain path leaves to it', () => {
    for (const t of [3, -1, 2.5, 'DELTA', 'AGGREGATION_TEMPORALITY_DELTA ', '2', null]) {
      expect(
        parity([resourceMetrics([sum([pt()], { sum: { aggregationTemporality: t, dataPoints: [pt()] } })])]),
      ).toBe(false);
    }
  });

  test('several value fields, several data fields and duplicate names fall back', () => {
    expect(parity([resourceMetrics([gauge([pt({ asDouble: 1 })])])])).toBe(false);
    expect(parity([resourceMetrics([gauge([pt()], { sum: { dataPoints: [] } })])])).toBe(false);
    const both = JSON.parse(
      `{"scopeMetrics":[{"metrics":[{"name":"g","gauge":{"dataPoints":[{"timeUnixNano":"${T1}","timeUnixNano":"${T0}"}]}}]}]}`,
    );
    expect(parity([both])).toBe(true); // JSON.parse keeps the last, as protobuf-es sees it
    const proto = JSON.parse(`{"__proto__":{"x":1},"scopeMetrics":[]}`);
    expect(parity([proto])).toBe(false);
  });

  test('exemplars, histograms and other point kinds go through protobuf-es', () => {
    const ex = pt({ exemplars: [{ timeUnixNano: T1, asDouble: 1 }] });
    expect(parity([resourceMetrics([sum([ex])])])).toBe(false);
    const h = { name: 'h', histogram: { dataPoints: [{ timeUnixNano: T1, count: '1' }] } };
    expect(parity([resourceMetrics([h])])).toBe(false);
  });

  test('deep attribute values: read up to the plain limit, protobuf-es beyond it (also past its own limit)', () => {
    const nest = (depth: number): unknown => {
      let v: unknown = { stringValue: 'leaf' };
      for (let i = 0; i < depth; i++) v = { kvlistValue: { values: [{ key: `k${i}`, value: v }] } };
      return v;
    };
    expect(parity([resourceMetrics([gauge([pt({ attributes: [{ key: 'deep', value: nest(10) }] })])])])).toBe(
      true,
    );
    expect(parity([resourceMetrics([gauge([pt({ attributes: [{ key: 'deep', value: nest(30) }] })])])])).toBe(
      false,
    );
    expect(parity([resourceMetrics([gauge([pt({ attributes: [{ key: 'deep', value: nest(80) }] })])])])).toBe(
      false,
    );
  });

  test('objects protobuf-es reads by their own enumerable keys only', () => {
    const p = pt();
    Object.defineProperty(p, 'flags', { value: 'hidden', enumerable: false });
    const proto = Object.assign(Object.create({ unit: 'inherited' }), gauge([p]));
    expect(parity([resourceMetrics([proto])])).toBe(true);
  });

  test('plainMetrics builds nothing for input it leaves to protobuf-es', () => {
    expect(plainMetrics([resourceMetrics([gauge([pt({ asInt: 'x' })])])])).toBeNull();
    expect(plainMetrics([resourceMetrics([gauge([pt()])])])?.earliest).toBe(BigInt(T1));
  });

  test('a plain request still exposes its protobuf-es message', () => {
    const req = requestOf(metricsEntry(), [resourceMetrics([gauge([pt()])])], 0, SOURCE);
    if (req.signal !== 'metrics') throw new Error('not metrics');
    expect(req.plain).toBeDefined();
    expect(req.request.resourceMetrics[0]?.scopeMetrics[0]?.metrics[0]?.name).toBe('temp');
    expect(req.request).toBe(req.request);
  });
});
