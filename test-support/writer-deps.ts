import { type ConfigInput, ConfigSchema, type ResolvedConfig } from '../src/config/schema.js';
import { parseUnixNanos } from '../src/model/ids.js';
import type { OtlpRequest } from '../src/model/otlp-json.js';
import { parseOtlpJson } from '../src/model/otlp-json.js';
import type { Logger, ProcessInfo, SpanHandle, Tracer } from '../src/writer/ports.js';
import type { WriterDeps } from '../src/writer/session.js';
import type { ViewerAssets } from '../src/writer/viewer-assets.js';
import { createFixedClock } from './fixed-clock.js';
import { createMemoryFileSystem } from './memory-fs.js';
import type { JsonObject } from './otlp-builders.js';

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  attrs: Record<string, unknown> | undefined;
}

export interface RecordedSpan {
  name: string;
  attrs: Record<string, string | number | boolean>;
  ended: boolean;
  error: unknown;
}

export interface FakeProcess extends ProcessInfo {
  /** Pids reported as alive; defaults to just this process. */
  alive: Set<number>;
}

export interface TestWriter {
  deps: WriterDeps;
  fs: ReturnType<typeof createMemoryFileSystem>;
  clock: ReturnType<typeof createFixedClock>;
  logs: LogEntry[];
  spans: RecordedSpan[];
  process: FakeProcess;
}

export const EPOCH_NS = '1700000000000000000';

export function fakeViewerAssets(): ViewerAssets {
  return {
    async files() {
      return [
        { path: 'assets/viewer.abc123.js', contents: new TextEncoder().encode('/* viewer */') },
        { path: 'assets/viewer.abc123.css', contents: new TextEncoder().encode('/* css */') },
      ];
    },
    entry: () => ({ script: 'assets/viewer.abc123.js', style: 'assets/viewer.abc123.css' }),
  };
}

export function createProcess(pid = 4242, hostname = 'host-a'): FakeProcess {
  const alive = new Set<number>([pid]);
  return { pid, hostname, alive, isAlive: (p) => alive.has(p) };
}

export function createTestWriter(
  overrides: { process?: FakeProcess; fs?: ReturnType<typeof createMemoryFileSystem>; version?: string } = {},
): TestWriter {
  const fs = overrides.fs ?? createMemoryFileSystem();
  const clock = createFixedClock(parseUnixNanos(EPOCH_NS, 'epoch'));
  const logs: LogEntry[] = [];
  const spans: RecordedSpan[] = [];
  const log =
    (level: LogEntry['level']) =>
    (msg: string, attrs?: Record<string, unknown>): void => {
      logs.push({ level, msg, attrs });
    };
  const logger: Logger = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
  const tracer: Tracer = {
    startSpan(name, attrs = {}): SpanHandle {
      const rec: RecordedSpan = { name, attrs: { ...attrs }, ended: false, error: undefined };
      spans.push(rec);
      return {
        setAttributes(a) {
          Object.assign(rec.attrs, a);
        },
        recordError(e) {
          rec.error = e;
        },
        end() {
          rec.ended = true;
        },
      };
    },
  };
  const process = overrides.process ?? createProcess();
  return {
    deps: {
      fs,
      clock,
      logger,
      tracer,
      process,
      viewerAssets: fakeViewerAssets(),
      version: overrides.version ?? '0.1.0',
    },
    fs,
    clock,
    logs,
    spans,
    process,
  };
}

export function testConfig(input: ConfigInput = {}): ResolvedConfig {
  return ConfigSchema.parse(input);
}

/** Parse an OTLP-JSON object into the single request it carries. */
export function otlp(json: JsonObject): OtlpRequest {
  const [r] = parseOtlpJson(JSON.stringify(json), 'test.json');
  if (r === undefined) throw new Error('no request');
  return r;
}
