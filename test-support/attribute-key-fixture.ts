import type { ConfigInput } from '../src/config/schema.js';
import type { OtlpRequest } from '../src/model/otlp-json.js';
import { attr, type JsonObject, logRecord, logsRequest, span, traceRequest } from './otlp-builders.js';
import { EPOCH_NS, otlp } from './writer-deps.js';

/** The key cap of the fixtures: below the number of attribute keys they hold, so the cap and its ties matter. */
export const KEY_CAP = 6;
export const keysConfig = (extra: ConfigInput['writer'] = {}): ConfigInput => ({
  writer: { format: 'site', facetKeyCap: KEY_CAP, ...extra },
});

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');

/** Values of every JSON kind an attribute can hold. */
const VALUES = {
  str: { stringValue: 'x' },
  int: { intValue: '3' },
  big: { intValue: '1152921504606846976' },
  dbl: { doubleValue: 1.5 },
  whole: { doubleValue: 2 },
  bool: { boolValue: false },
  blank: { stringValue: '' },
  nil: {},
  obj: { kvlistValue: { values: [{ key: 'a', value: { stringValue: '1' } }] } },
  arr: { arrayValue: { values: [{ stringValue: '1' }] } },
  bytes: { bytesValue: 'AQI=' },
} satisfies Record<string, JsonObject>;

/**
 * What each fixture record holds: `k00` to `k11` (twelve keys, over `KEY_CAP`) with counts that tie at the cap, keys of
 * one kind each, a key of mixed kinds, keys with no scalar value, and keys that are core keys or start with `$`.
 */
const COUNTS = [20, 20, 15, 15, 15, 10, 10, 8, 5, 5, 3, 1];
/** Attributes of record `i` (0 to 19), by which keys it holds. */
function attributesOf(i: number, round: number): JsonObject[] {
  const out: JsonObject[] = [];
  COUNTS.forEach((n, j) => {
    // round 1 holds a different share, so a report with two partitions sums unlike counts
    if (i < n - round * Math.min(2, j % 3)) out.push(attr(`k${String(j).padStart(2, '0')}`, VALUES.str));
  });
  out.push(attr('mx', i % 2 === 0 ? VALUES.str : VALUES.int));
  if (i < 3) out.push(attr('blank', VALUES.blank));
  if (i < 4) out.push(attr('flag', VALUES.bool));
  if (i < 2) out.push(attr('dbl', VALUES.dbl), attr('whole', VALUES.whole));
  if (i < 1) out.push(attr('big', VALUES.big));
  out.push(attr('nil', VALUES.nil));
  if (i < 6) out.push(attr('obj', VALUES.obj), attr('arr', VALUES.arr));
  if (i < 5) out.push(attr('by', VALUES.bytes));
  if (i < 7) out.push(attr('service.name', VALUES.str), attr('span.name', VALUES.str));
  if (i < 9) out.push(attr('$dollar', VALUES.str));
  if (round === 1 && i < 4) out.push(attr('late', VALUES.int));
  return out;
}

const RESOURCE = [
  attr('service.name', { stringValue: 'svc' }),
  attr('host.name', { stringValue: 'h1' }),
  attr('deployment.environment.name', { stringValue: 'prod' }),
];

/** Twenty spans with the attributes above; `round` and `first` keep several requests' span ids apart. */
export function keySpans(round = 0): OtlpRequest {
  const base = BigInt(EPOCH_NS);
  const spans = Array.from({ length: 20 }, (_, i) =>
    span({
      traceId: hex(round * 100 + i + 1, 32),
      spanId: hex(round * 100 + i + 1, 16),
      name: `op${i % 3}`,
      startTimeUnixNano: String(base + BigInt(round) * 1_000_000n + BigInt(i) * 1000n),
      endTimeUnixNano: String(base + BigInt(round) * 1_000_000n + BigInt(i) * 1000n + 500n),
      attributes: attributesOf(i, round),
    }),
  );
  return otlp(traceRequest(spans, RESOURCE));
}

/** The same shapes as log records, with an event name so every core log key has a value. */
export function keyLogs(round = 0): OtlpRequest {
  const base = BigInt(EPOCH_NS);
  const records = Array.from({ length: 20 }, (_, i) =>
    logRecord({
      timeUnixNano: String(base + BigInt(round) * 1_000_000n + BigInt(i) * 1000n),
      observedTimeUnixNano: String(base + BigInt(round) * 1_000_000n + BigInt(i) * 1000n),
      eventName: 'ev',
      attributes: attributesOf(i, round),
      ...(i % 2 === 0 ? { traceId: hex(i + 1, 32), spanId: hex(i + 1, 16) } : {}),
    }),
  );
  return otlp(logsRequest(records, RESOURCE));
}
