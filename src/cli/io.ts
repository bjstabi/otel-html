import type { spawn } from 'node:child_process';
import type { ConfigInput } from '../config/schema.js';

export type StopSignal = 'SIGINT' | 'SIGTERM';

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** Subscribe to stop signals; returns the unsubscribe. */
  signals: { on(fn: (signal: StopSignal) => void): () => void };
  spawn: typeof spawn;
}

/** Flags that map onto configuration; the schema validates them like any other layer. */
export interface ConfigFlags {
  config?: string;
  title?: string;
}

/** Receiver flags; a port of `false` is `--no-http` / `--no-grpc`. */
export interface ReceiverFlags extends ConfigFlags {
  host?: string;
  http?: number | false;
  grpc?: number | false;
  append?: boolean;
}

function listenerOf(port: number | false | undefined): { enabled: boolean; port?: number } | undefined {
  if (port === undefined) return undefined;
  return port === false ? { enabled: false } : { enabled: true, port };
}

export function configInputOf(flags: ConfigFlags | ReceiverFlags): ConfigInput {
  const input: ConfigInput = flags.title === undefined ? {} : { title: flags.title };
  if (!('host' in flags || 'http' in flags || 'grpc' in flags)) return input;
  const http = listenerOf(flags.http);
  const grpc = listenerOf(flags.grpc);
  const receiver = {
    ...(flags.host === undefined ? {} : { host: flags.host }),
    ...(http === undefined ? {} : { http }),
    ...(grpc === undefined ? {} : { grpc }),
  };
  return Object.keys(receiver).length === 0 ? input : { ...input, receiver };
}
