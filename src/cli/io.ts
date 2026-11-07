import type { spawn } from 'node:child_process';
import type { ConfigInput, ReportFormat } from '../config/schema.js';

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

/**
 * Flags shared by every writing command: the ones that map onto configuration (the schema validates
 * them like any other layer) and the report mode flags `--append`/`--replace`, which do not.
 */
export interface ConfigFlags {
  config?: string;
  title?: string;
  /** `--append`: require a report at -o and add to it. */
  append?: boolean;
  /** `--replace`: start the report over. */
  replace?: boolean;
  /** `--format`: the report format to write (`writer.format`). */
  format?: ReportFormat;
  /** `--assets-base`: where the report loads its viewer files from (`writer.assetsBase`). */
  assetsBase?: string;
}

/** Receiver flags; a port of `false` is `--no-http` / `--no-grpc`. */
export interface ReceiverFlags extends ConfigFlags {
  host?: string;
  http?: number | false;
  grpc?: number | false;
}

function listenerOf(port: number | false | undefined): { enabled: boolean; port?: number } | undefined {
  if (port === undefined) return undefined;
  return port === false ? { enabled: false } : { enabled: true, port };
}

export function configInputOf(flags: ConfigFlags | ReceiverFlags): ConfigInput {
  const writer = {
    ...(flags.format === undefined ? {} : { format: flags.format }),
    ...(flags.assetsBase === undefined ? {} : { assetsBase: flags.assetsBase }),
  };
  const input: ConfigInput = {
    ...(flags.title === undefined ? {} : { title: flags.title }),
    ...(Object.keys(writer).length === 0 ? {} : { writer }),
  };
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
