import type { JsonObject } from './otlp-builders.js';

/**
 * Deterministic OTLP/JSON log generator for the scale report and the log-size test. Log `i` is a pure function of
 * `i` (no shared RNG state), so any slice of the stream can be generated on its own, in any order.
 */

/** Logs per trace slot: 500 consecutive logs belong to one trace, 70 % of them carrying its ids. */
export const LOGS_PER_TRACE_SLOT = 500;
const TRACE_CARRY_PERCENT = 70;
/** Gap between consecutive log timestamps. */
export const LOG_STEP_NS = 10_000_000n;

/** Where a log's trace and span ids come from; the scale report points them at the scale spans. */
export interface ScaleLogIds {
  readonly services: readonly string[];
  readonly hosts: readonly string[];
  readonly traces: number;
  readonly spansPerTrace: number;
  readonly epochNs: bigint;
  traceId(t: number): string;
  spanId(t: number, j: number): string;
}

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');

export const TEST_SCALE_IDS: ScaleLogIds = {
  services: ['edge', 'api', 'auth', 'db', 'cache', 'queue', 'worker', 'search'],
  hosts: ['host-0', 'host-1', 'host-2', 'host-3'],
  traces: 2000,
  spansPerTrace: 50,
  epochNs: 1_700_000_000_000_000_000n,
  traceId: (t) => `${hex(t + 1, 8)}${'a1'.repeat(12)}`,
  spanId: (t, j) => hex(t * 50 + j + 1, 16),
};

/** A 32-bit hash of (i, salt): well mixed, stateless. */
function mix(i: number, salt: number): number {
  let h = (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Forty body shapes; each `#` becomes a number of its own, so shapes share structure and differ in values. */
const SHAPES: readonly string[] = [
  'GET /api/v1/items/# 200 in #ms',
  'POST /api/v1/orders 201 in #ms order=#',
  'GET /api/v1/users/# 404 in #ms',
  'PUT /api/v1/carts/# 200 in #ms items=#',
  'DELETE /api/v1/sessions/# 204 in #ms',
  'cache hit key=item:# ttl=#s',
  'cache miss key=user:# after #ms',
  'cache evicted # entries in #ms',
  'db query select_orders rows=# took #ms',
  'db query update_stock rows=# took #ms',
  'db connection pool size=# idle=# waiting=#',
  'db transaction # committed in #ms',
  'queue publish topic=orders partition=# offset=#',
  'queue consume topic=payments lag=# batch=#',
  'worker job # started attempt=#',
  'worker job # finished in #ms',
  'retrying request to payments after #ms attempt #',
  'upstream search responded # hits in #ms',
  'auth token validated for user # expires in #s',
  'auth login failed for user # from 10.0.#.# attempts=#',
  'rate limit reached for client # limit=# window=#s',
  'user # logged in from 10.1.#.#',
  'user # logged out session=#',
  'payment # authorized amount=# cents',
  'payment # declined code=# amount=# cents',
  'inventory sku=# reserved qty=#',
  'inventory sku=# low stock remaining=#',
  'email # queued to user # size=# bytes',
  'GC pause #ms heap=#MB',
  'heartbeat from node-# seq=#',
  'config reloaded version=# in #ms',
  'request # exceeded deadline of #ms',
  'connection reset by peer 10.2.#.# port=#',
  'TLS handshake completed in #ms session=#',
  'metrics flushed # points in #ms',
  'span export batch=# size=# took #ms',
  'migration # applied in #ms',
  'feature flag # evaluated variant=#',
  'search index shard=# refreshed docs=#',
  'timeout waiting for lock # after #ms',
];

/** Severity number weighted 60 % info, 25 % debug, 10 % warn, 5 % error. */
function severityOf(r: number): { number: number; text: string } {
  const p = r % 100;
  if (p < 60) return { number: 9, text: 'INFO' };
  if (p < 85) return { number: 5, text: 'DEBUG' };
  if (p < 95) return { number: 13, text: 'WARN' };
  return { number: 17, text: 'ERROR' };
}

function bodyOf(i: number): string {
  const shape = SHAPES[mix(i, 1) % SHAPES.length] ?? '';
  let k = 0;
  return shape.replace(/#/g, () =>
    String(mix(i, 100 + k++) % (k % 3 === 0 ? 100_000 : k % 3 === 1 ? 1000 : 100)),
  );
}

/** The trace a log belongs to, or null. Slot `t` of `LOGS_PER_TRACE_SLOT` consecutive logs belongs to trace `t`. */
export function scaleLogTrace(i: number, ids: ScaleLogIds): number | null {
  if (mix(i, 2) % 100 >= TRACE_CARRY_PERCENT) return null;
  return Math.floor(i / LOGS_PER_TRACE_SLOT) % ids.traces;
}

function recordOf(i: number, ids: ScaleLogIds): JsonObject {
  const t = scaleLogTrace(i, ids);
  const sev = severityOf(mix(i, 3));
  return {
    timeUnixNano: String(ids.epochNs + BigInt(i) * LOG_STEP_NS),
    severityNumber: sev.number,
    severityText: sev.text,
    body: { stringValue: bodyOf(i) },
    attributes: [{ key: 'thread.id', value: { intValue: String(mix(i, 4) % 64) } }],
    ...(t === null ? {} : { traceId: ids.traceId(t), spanId: ids.spanId(t, mix(i, 5) % ids.spansPerTrace) }),
  };
}

/** Consecutive logs from one resource: service changes every run, host every `services.length` runs. */
const RUN_LENGTH = 50;

/**
 * Logs `first .. first + count - 1` as one OTLP/JSON request. Records stay in index (time) order, as an SDK batch
 * would deliver them: a new `resourceLogs` entry starts whenever the emitting service or host changes, so a chunk
 * holds a contiguous time range. Service and host come from the index, so a slice splits the same way wherever it starts.
 */
export function scaleLogsRequest(first: number, count: number, ids: ScaleLogIds): JsonObject {
  const runs: { service: string; host: string; records: JsonObject[] }[] = [];
  for (let i = first; i < first + count; i++) {
    const run = Math.floor(i / RUN_LENGTH);
    const service = ids.services[run % ids.services.length] ?? 'edge';
    const host = ids.hosts[Math.floor(run / ids.services.length) % ids.hosts.length] ?? 'host-0';
    let g = runs.at(-1);
    if (g === undefined || g.service !== service || g.host !== host) {
      g = { service, host, records: [] };
      runs.push(g);
    }
    g.records.push(recordOf(i, ids));
  }
  return {
    resourceLogs: runs.map((g) => ({
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: g.service } },
          { key: 'host.name', value: { stringValue: g.host } },
        ],
      },
      scopeLogs: [{ scope: { name: 'e2e-scale' }, logRecords: g.records }],
    })),
  };
}
