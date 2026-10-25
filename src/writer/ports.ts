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
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
}

export interface ProcessInfo {
  pid: number;
  hostname: string;
  isAlive(pid: number): boolean;
}
