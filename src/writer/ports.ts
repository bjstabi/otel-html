import type { UnixNanos } from '../model/ids.js';

export interface FileSystem {
  readText(p: string): Promise<string>;
  writeTextAtomic(p: string, text: string): Promise<void>;
  writeBytes(p: string, bytes: Uint8Array): Promise<void>;
  mkdirp(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;
  remove(p: string): Promise<void>;
  /** Resolves false if the file already exists. */
  createExclusive(p: string, text: string): Promise<boolean>;
}

export interface Clock {
  nowUnixNano(): UnixNanos;
  monotonicMs(): number;
}

export interface Logger {
  debug(msg: string, attrs?: Record<string, unknown>): void;
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
}

export interface ProcessInfo {
  pid: number;
  hostname: string;
  isAlive(pid: number): boolean;
}

export type SpanAttributeValue = string | number | boolean;

/** Self-telemetry: a minimal span handle. Implementations map this onto an OTel Tracer. */
export interface SpanHandle {
  setAttributes(attrs: Record<string, SpanAttributeValue>): void;
  recordError(error: unknown): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, attrs?: Record<string, SpanAttributeValue>): SpanHandle;
}
