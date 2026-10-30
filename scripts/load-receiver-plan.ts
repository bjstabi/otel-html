import { parseArgs } from 'node:util';

/** Pinned: telemetrygen's flags change between releases. */
export const TELEMETRYGEN_IMAGE: string =
  'ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:v0.140.0';
/** Spec §7: writer peak RSS. */
export const MAX_RSS_KB: number = 512 * 1024;
/** `telemetrygen traces` makes one root span and `--child-spans` (default 1) children per trace. */
const SPANS_PER_TRACE = 2;
/**
 * 500 spans/s per worker: telemetrygen's `--rate` counts spans (the limiter runs before the root and before each
 * child), so at 2 spans per trace that is 250 traces/s; 8 workers → 4,000 spans/s, about 250 s for 1M spans — well
 * under the ~18k spans/s one exporter pushed through during the unthrottled burst. Unthrottled (`--rate 0`) the trace
 * generator has no backpressure: it makes hundreds of thousands of traces a second and its batch span processor drops
 * what the exporter has not sent. The logs path exports one request per record synchronously, so it stays unthrottled.
 */
export const SPANS_PER_SECOND_PER_WORKER = 500;

export function tracesArgs(image: string, port: number, workers: number, tracesPerWorker: number): string[] {
  return [
    image,
    'traces',
    '--otlp-insecure',
    '--otlp-endpoint',
    `127.0.0.1:${port}`,
    '--workers',
    String(workers),
    '--traces',
    String(tracesPerWorker),
    '--rate',
    String(SPANS_PER_SECOND_PER_WORKER),
  ];
}

export function logsArgs(image: string, port: number, workers: number, logsPerWorker: number): string[] {
  return [
    image,
    'logs',
    '--otlp-http',
    '--otlp-insecure',
    '--otlp-endpoint',
    `127.0.0.1:${port}`,
    '--workers',
    String(workers),
    '--logs',
    String(logsPerWorker),
    '--rate',
    '0',
  ];
}

export interface LoadArgs {
  spans: number;
  logs: number;
  workers: number;
  out: string;
  image: string;
}

function positiveInt(flag: string, text: string): number {
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(text)}`);
  }
  return n;
}

export function parseLoadArgs(argv: readonly string[]): LoadArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      spans: { type: 'string', default: '1000000' },
      logs: { type: 'string', default: '1000000' },
      workers: { type: 'string', default: '8' },
      out: { type: 'string' },
      image: { type: 'string', default: TELEMETRYGEN_IMAGE },
    },
    strict: true,
  });
  if (values.out === undefined) throw new Error('--out <dir> is required');
  return {
    spans: positiveInt('--spans', values.spans),
    logs: positiveInt('--logs', values.logs),
    workers: positiveInt('--workers', values.workers),
    out: values.out,
    image: values.image,
  };
}

export interface WorkloadPlan {
  tracesPerWorker: number;
  logsPerWorker: number;
}

/** telemetrygen's `--traces` and `--logs` are per worker, so the totals must divide exactly to come out exact. */
export function planWorkload(a: Pick<LoadArgs, 'spans' | 'logs' | 'workers'>): WorkloadPlan {
  const spansStep = SPANS_PER_TRACE * a.workers;
  if (a.spans % spansStep !== 0) {
    throw new Error(
      `--spans must be a multiple of ${spansStep} (${SPANS_PER_TRACE} per trace × ${a.workers} workers)`,
    );
  }
  if (a.logs % a.workers !== 0) throw new Error(`--logs must be a multiple of --workers (${a.workers})`);
  return { tracesPerWorker: a.spans / spansStep, logsPerWorker: a.logs / a.workers };
}

/** The `MAXRSS <kb>` line the preload writes to stderr as the process exits. */
export function parseMaxRssKb(stderr: string): number | null {
  const m = /^MAXRSS (\d+)$/m.exec(stderr);
  return m?.[1] === undefined ? null : Number(m[1]);
}

export interface StallStats {
  loopP99Ms: number;
  loopMaxMs: number;
  gcCount: number;
  gcTotalMs: number;
  gcMaxMs: number;
}

/** The `LOOP p99 <ms> max <ms>` and `GC count <n> total <ms> max <ms>` lines the preload writes as the process exits. */
export function parseStallStats(stderr: string): StallStats | null {
  const loop = /^LOOP p99 (\d+(?:\.\d+)?) max (\d+(?:\.\d+)?)$/m.exec(stderr);
  const gc = /^GC count (\d+) total (\d+(?:\.\d+)?) max (\d+(?:\.\d+)?)$/m.exec(stderr);
  if (loop?.[1] === undefined || loop[2] === undefined) return null;
  if (gc?.[1] === undefined || gc[2] === undefined || gc[3] === undefined) return null;
  return {
    loopP99Ms: Number(loop[1]),
    loopMaxMs: Number(loop[2]),
    gcCount: Number(gc[1]),
    gcTotalMs: Number(gc[2]),
    gcMaxMs: Number(gc[3]),
  };
}

export interface Received {
  /** Requests that failed outright. */
  refused: number;
  /** Records dropped from requests that were otherwise accepted. */
  rejected: number;
}

/** The counts in serve's `received N requests (K refused); M records rejected` line. */
export function parseReceived(stdout: string): Received | null {
  const m = /received \d+ requests \((\d+) refused\); (\d+) records rejected/.exec(stdout);
  return m?.[1] === undefined || m[2] === undefined
    ? null
    : { refused: Number(m[1]), rejected: Number(m[2]) };
}

export interface LoadManifest {
  complete: boolean;
  totals: { spans: number; logs: number; metrics: number };
}

/** `data/manifest.js` is `__OH__.push("manifest",{...});`. */
export function parseManifestJs(text: string): LoadManifest {
  const m = /^__OH__\.push\("manifest",(\{[\s\S]*\})\);?\s*$/.exec(text);
  if (m?.[1] === undefined) throw new Error('data/manifest.js does not hold a manifest');
  const value: unknown = JSON.parse(m[1]);
  if (typeof value !== 'object' || value === null) throw new Error('the manifest is not an object');
  const { complete, totals } = value as { complete?: unknown; totals?: Partial<LoadManifest['totals']> };
  const { spans, logs, metrics } = totals ?? {};
  if (
    typeof complete !== 'boolean' ||
    typeof spans !== 'number' ||
    typeof logs !== 'number' ||
    typeof metrics !== 'number'
  ) {
    throw new Error('the manifest lacks complete or totals');
  }
  return { complete, totals: { spans, logs, metrics } };
}

export interface RunResult {
  manifest: LoadManifest;
  want: { spans: number; logs: number };
  received: Received | null;
  rssKb: number | null;
}

/** Every failed assertion, named; empty when the run passes. */
export function checkRun(r: RunResult): string[] {
  const failures: string[] = [];
  if (!r.manifest.complete) failures.push('manifest is not complete');
  for (const key of ['spans', 'logs'] as const) {
    if (r.manifest.totals[key] !== r.want[key]) {
      failures.push(`totals.${key}: expected ${r.want[key]}, got ${r.manifest.totals[key]}`);
    }
  }
  if (r.received === null) failures.push('serve printed no received line');
  else {
    if (r.received.refused !== 0) failures.push(`${r.received.refused} requests refused, expected 0`);
    if (r.received.rejected !== 0) failures.push(`${r.received.rejected} records rejected, expected 0`);
  }
  if (r.rssKb === null) failures.push('no MAXRSS line: peak RSS unknown');
  else if (r.rssKb >= MAX_RSS_KB) {
    failures.push(`peak RSS ${(r.rssKb / 1024).toFixed(0)} MB, limit ${MAX_RSS_KB / 1024} MB`);
  }
  return failures;
}
