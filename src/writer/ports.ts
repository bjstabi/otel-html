import type { UnixNanos } from '../model/ids.js';

export interface FileSystem {
  readText(p: string): Promise<string>;
  readBytes(p: string): Promise<Uint8Array>;
  /** The file's bytes in pieces, so a large file need not be held whole. Without it, `readBytes` is used. */
  readChunks?(p: string): AsyncIterable<Uint8Array>;
  writeTextAtomic(p: string, text: string): Promise<void>;
  /** `writeTextAtomic` of the pieces joined, written as they come. Without it, the joined text is written. */
  writePiecesAtomic?(p: string, pieces: Iterable<string>): Promise<void>;
  writeBytes(p: string, bytes: Uint8Array): Promise<void>;
  mkdirp(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  /** Canonical form of an existing path (symlinks resolved, on-disk case); rejects when it does not exist. */
  realpath(p: string): Promise<string>;
  list(dir: string): Promise<string[]>;
  remove(p: string): Promise<void>;
  /** Resolves false if the file already exists. */
  createExclusive(p: string, text: string): Promise<boolean>;
}

export interface Clock {
  nowUnixNano(): UnixNanos;
  monotonicMs(): number;
}

export interface Timers {
  /** Runs `fn` once after `ms`; the returned function cancels it (a no-op once it has fired or been cancelled). */
  after(ms: number, fn: () => void): () => void;
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
