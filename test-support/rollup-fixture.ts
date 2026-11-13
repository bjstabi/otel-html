import type { ConfigInput } from '../src/config/schema.js';
import { type ManifestV4, ROLLUP_GRAIN_NS } from '../src/format/manifest.js';
import { ROLLUP_OF, type RollupTable } from '../src/format/parquet/columns.js';
import type { OtlpRequest } from '../src/model/otlp-json.js';
import { buildFormat4Report, type Format4Fixture } from './format4-fixture.js';
import { attr, type JsonObject, logRecord, logsRequest, span, traceRequest } from './otlp-builders.js';
import { EPOCH_NS, otlp } from './writer-deps.js';

/**
 * Edge-case OTLP input for the rollup tests, written three ways (`layouts`): every partition with rollups, none (the
 * partitions of format 4), and a mix in which one spans and one logs partition carry a rollup with fewer dimensions
 * than its neighbours. Times are absolute and aligned to the rollup grain, so a window can sit exactly on an edge.
 */

export const GRAIN: bigint = BigInt(ROLLUP_GRAIN_NS);
export const BASE: bigint = BigInt(EPOCH_NS);
/** The first grain edge at or after the report's epoch. */
export const E0: bigint = ((BASE + GRAIN - 1n) / GRAIN) * GRAIN;
/** The grain edge `k` grains after `E0`, plus `extra` nanoseconds. */
export const edge = (k: number, extra = 0n): bigint => E0 + BigInt(k) * GRAIN + extra;

/** The long window of the tests: 300 grains from `E0`, aligned in absolute time, relative to `epoch`. */
export const longWindow = (epoch: bigint = BASE): { start: number; end: number } => ({
  start: Number(edge(0) - epoch),
  end: Number(edge(300) - epoch),
});
/** A short window (16 grains): the exact percentiles of today. */
export const shortWindow = (epoch: bigint = BASE): { start: number; end: number } => ({
  start: Number(edge(10) - epoch),
  end: Number(edge(26) - epoch),
});

const str = (v: string): JsonObject => ({ stringValue: v });

export interface SpanSpec {
  id: number;
  trace: number;
  svc: string;
  run: string;
  host?: string;
  name: string;
  /** 0 unset, 1 ok, 2 error */
  status?: 0 | 1 | 2;
  startNs: bigint;
  durNs: bigint;
  attrs?: JsonObject[];
}

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');

export function spansRequest(specs: readonly SpanSpec[]): OtlpRequest {
  const resourceSpans: unknown[] = [];
  const groups = new Map<string, SpanSpec[]>();
  for (const s of specs) {
    const k = `${s.svc}|${s.run}|${s.host ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  for (const mine of groups.values()) {
    const [first] = mine;
    if (first === undefined) continue;
    const spans = mine.map((s) =>
      span({
        traceId: hex(s.trace, 32),
        spanId: hex(s.id, 16),
        name: s.name,
        startTimeUnixNano: String(s.startNs),
        endTimeUnixNano: String(s.startNs + s.durNs),
        ...(s.status === undefined || s.status === 0 ? {} : { status: { code: s.status } }),
        attributes: s.attrs ?? [],
      }),
    );
    const resource = [
      attr('service.name', str(first.svc)),
      attr('run.id', str(first.run)),
      ...(first.host === undefined ? [] : [attr('host.name', str(first.host))]),
    ];
    const r = traceRequest(spans, resource) as { resourceSpans: unknown[] };
    resourceSpans.push(...r.resourceSpans);
  }
  return otlp({ resourceSpans } as never);
}

export interface LogSpec {
  svc: string;
  run: string;
  host?: string;
  /** Absolute nanoseconds, null for none. */
  timeNs: bigint | null;
  observedNs?: bigint | null;
  severity: number;
  trace?: number;
  event?: string;
  attrs?: JsonObject[];
}

export function logsOf(specs: readonly LogSpec[]): OtlpRequest {
  const resourceLogs: unknown[] = [];
  const groups = new Map<string, LogSpec[]>();
  for (const s of specs) {
    const k = `${s.svc}|${s.run}|${s.host ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  for (const mine of groups.values()) {
    const [first] = mine;
    if (first === undefined) continue;
    const records = mine.map((s): JsonObject => {
      const { timeUnixNano: _t, observedTimeUnixNano: _o, ...rest } = logRecord({ body: str('log') });
      return {
        ...rest,
        ...(s.timeNs === null ? {} : { timeUnixNano: String(s.timeNs) }),
        ...(s.observedNs == null ? {} : { observedTimeUnixNano: String(s.observedNs) }),
        severityNumber: s.severity,
        ...(s.trace === undefined ? {} : { traceId: hex(s.trace, 32) }),
        ...(s.event === undefined ? {} : { eventName: s.event }),
        attributes: s.attrs ?? [],
      };
    });
    const resource = [
      attr('service.name', str(first.svc)),
      attr('run.id', str(first.run)),
      ...(first.host === undefined ? [] : [attr('host.name', str(first.host))]),
    ];
    const r = logsRequest(records, resource) as { resourceLogs: unknown[] };
    resourceLogs.push(...r.resourceLogs);
  }
  return otlp({ resourceLogs } as never);
}

/** The values of `k.mixed`: a string, a number and a boolean in different spans. */
const MIXED: readonly JsonObject[] = [str('5'), { intValue: '5' }, { boolValue: true }, { doubleValue: 5.5 }];

const DURATIONS: readonly bigint[] = [
  0n,
  1n,
  999n,
  1_000_000n,
  3_000_000n,
  7_500_000n,
  42_000_000n,
  1_000_000_000n,
  64n,
  250_000_000n,
];

function spanPartitions(): SpanSpec[][] {
  const out: SpanSpec[][] = [[], [], [], []];
  const slices = [
    [-5, 80],
    [80, 160],
    [160, 240],
    [240, 322],
  ] as const;
  let id = 1;
  slices.forEach(([from, to], p) => {
    const part = out[p] ?? [];
    for (let g = from; g < to; g += 7) {
      const k = id;
      part.push({
        id: id++,
        trace: 1 + (k % 9),
        svc: ['svc-a', 'svc-b', 'svc-c'][k % 3] ?? 'svc-a',
        run: `r${p + 1}`,
        ...(k % 4 === 0 ? { host: `h${k % 3}` } : {}),
        name: ['GET /a', 'GET /b', 'POST /c', 'job'][k % 4] ?? 'job',
        status: ([0, 1, 2] as const)[Math.floor(k / 3) % 3] ?? 0,
        startNs: edge(g, BigInt((k * 7_919) % 60_000) * 1_000_000n),
        durNs: DURATIONS[k % DURATIONS.length] ?? 0n,
        attrs: [
          attr('http.route', str(k % 2 === 0 ? '/a' : '/b')),
          attr('k.mixed', MIXED[k % MIXED.length] ?? str('5')),
          ...(k % 5 === 0 ? [attr('k.empty', str(''))] : k % 5 === 1 ? [attr('k.empty', str('x'))] : []),
        ],
      });
    }
  });
  // The edges: exactly on the window's start and end, a nanosecond either side, and a duration of zero.
  const edges: SpanSpec[] = [
    { id: 9001, trace: 20, svc: 'svc-a', run: 'r1', name: 'edge-start', startNs: edge(0), durNs: 5_000_000n },
    {
      id: 9002,
      trace: 21,
      svc: 'svc-a',
      run: 'r1',
      name: 'edge-before',
      startNs: edge(0) - 1n,
      durNs: 5_000_000n,
    },
    // it started before the window and overlaps it: selected by start time, it is not in the window
    {
      id: 9003,
      trace: 22,
      svc: 'svc-b',
      run: 'r1',
      name: 'edge-overlap',
      startNs: edge(-2),
      durNs: 3n * GRAIN,
    },
    { id: 9004, trace: 23, svc: 'svc-b', run: 'r4', name: 'edge-end', startNs: edge(300), durNs: 5_000_000n },
    {
      id: 9005,
      trace: 24,
      svc: 'svc-b',
      run: 'r4',
      name: 'edge-last',
      startNs: edge(300) - 1n,
      durNs: 5_000_000n,
    },
    {
      id: 9006,
      trace: 25,
      svc: 'svc-c',
      run: 'r2',
      name: 'edge-zero',
      startNs: edge(100),
      durNs: 0n,
      status: 2,
    },
    { id: 9007, trace: 26, svc: 'svc-c', run: 'r2', name: 'edge-grain', startNs: edge(150), durNs: 1_000n },
    {
      id: 9008,
      trace: 27,
      svc: 'svc-c',
      run: 'r3',
      name: 'edge-next-grain',
      startNs: edge(151) - 1n,
      durNs: 1_000n,
    },
  ];
  for (const e of edges)
    (out[e.run === 'r4' ? 3 : e.run === 'r3' ? 2 : e.run === 'r2' ? 1 : 0] ?? []).push(e);
  return out;
}

function logPartitions(): LogSpec[][] {
  const out: LogSpec[][] = [[], [], []];
  const slices = [
    [-3, 100],
    [100, 200],
    [200, 320],
  ] as const;
  let n = 0;
  slices.forEach(([from, to], p) => {
    const part = out[p] ?? [];
    for (let g = from; g < to; g += 9) {
      n++;
      part.push({
        svc: ['svc-a', 'svc-b'][n % 2] ?? 'svc-a',
        run: `r${p + 1}`,
        ...(n % 3 === 0 ? { host: 'h1' } : {}),
        timeNs: edge(g, BigInt((n * 3_001) % 60_000) * 1_000_000n),
        severity: [1, 5, 9, 13, 17, 21][n % 6] ?? 9,
        ...(n % 4 === 0 ? { trace: 1 + (n % 5) } : {}),
        ...(n % 5 === 0 ? { event: 'ev' } : n % 5 === 1 ? { event: '' } : {}),
        attrs: [attr('k.mixed', MIXED[n % MIXED.length] ?? str('5'))],
      });
    }
  });
  const a = out[0] ?? [];
  a.push(
    { svc: 'svc-a', run: 'r1', timeNs: edge(0), severity: 9 },
    { svc: 'svc-a', run: 'r1', timeNs: edge(0) - 1n, severity: 9 },
    // only an observed time: it is the log's time
    { svc: 'svc-b', run: 'r1', timeNs: null, observedNs: edge(5, 1_000n), severity: 13 },
    // no time at all: counted without a window on a long range, not under a long window
    { svc: 'svc-b', run: 'r1', timeNs: null, severity: 17, trace: 7 },
  );
  (out[2] ?? []).push(
    { svc: 'svc-a', run: 'r3', timeNs: edge(300), severity: 9 },
    { svc: 'svc-a', run: 'r3', timeNs: edge(300) - 1n, severity: 9 },
  );
  return out;
}

export function reportRequests(): OtlpRequest[] {
  const s = spanPartitions().map((p) => spansRequest(p));
  const l = logPartitions().map((p) => logsOf(p));
  // partitions in time order, logs between the spans
  return [s[0], l[0], s[1], l[1], s[2], s[3], l[2]].flatMap((r) => (r === undefined ? [] : [r]));
}

/** The statistics keys the rollups of layout A hold beside the core facets. */
export const STATISTICS_KEYS = ['resource:run.id', 'attr:k.mixed', 'attr:k.empty'] as const;
const WITH_KEYS: ConfigInput = { writer: { statisticsKeys: [...STATISTICS_KEYS] } };

export interface Layout {
  name: 'rollups' | 'raw' | 'mixed';
  fixture: Format4Fixture;
}

const ROLLUPS: readonly RollupTable[] = Object.keys(ROLLUP_OF) as RollupTable[];

/** The manifest without the rollup entries (a format-4 report), and its files without the rollup files. */
export function withoutRollups(f: Format4Fixture): Format4Fixture {
  const files = new Map(f.files);
  const manifest: ManifestV4 = {
    ...f.manifest,
    partitions: f.manifest.partitions.map((p) => {
      const kept = { ...p.files };
      for (const t of ROLLUPS) {
        const entry = kept[t];
        if (entry !== undefined) files.delete(entry.path);
        delete kept[t];
      }
      return { ...p, files: kept };
    }),
  };
  return { ...f, manifest, files };
}

/**
 * `rich` with the rollup of partition `n` (its `table`) replaced by `plain`'s: the same rows with the core dimensions
 * only. When `noValue`, its statistics record "no value" for the keys of `rich` it does not hold, as a rollup written
 * with a smaller `statisticsKeys` list would not, but a careless pruning would read them.
 */
export function withWeakRollup(
  rich: Format4Fixture,
  plain: Format4Fixture,
  table: RollupTable,
  n: number,
  noValue = true,
): Format4Fixture {
  const files = new Map(rich.files);
  const manifest: ManifestV4 = {
    ...rich.manifest,
    partitions: rich.manifest.partitions.map((p) => {
      if (p.n !== n) return p;
      const weak = plain.manifest.partitions.find((q) => q.n === n)?.files[table];
      const old = p.files[table];
      if (weak === undefined || old === undefined) return p;
      const bytes = plain.files.get(weak.path);
      if (bytes === undefined) return p;
      files.set(old.path, bytes);
      const values = { ...weak.values };
      if (noValue) for (const key of rich.manifest.statisticsKeys[table] ?? []) values[key] ??= [];
      return { ...p, files: { ...p.files, [table]: { ...weak, path: old.path, values } } };
    }),
  };
  return { ...rich, manifest, files };
}

/** The input written three ways. */
export async function buildLayouts(): Promise<{ A: Layout; B: Layout; C: Layout }> {
  const requests = reportRequests();
  const rich = await buildFormat4Report(requests, { config: WITH_KEYS, close: false });
  const plain = await buildFormat4Report(requests, { close: false });
  const spansP = rich.manifest.partitions.find((p) => p.files.span_rollups !== undefined)?.n;
  const logsP = rich.manifest.partitions.find((p) => p.files.log_rollups !== undefined)?.n;
  if (spansP === undefined || logsP === undefined) throw new Error('the fixture has no rollups');
  const mixed = withWeakRollup(
    withWeakRollup(rich, plain, 'span_rollups', spansP),
    plain,
    'log_rollups',
    logsP,
  );
  return {
    A: { name: 'rollups', fixture: rich },
    B: { name: 'raw', fixture: withoutRollups(rich) },
    C: { name: 'mixed', fixture: mixed },
  };
}
