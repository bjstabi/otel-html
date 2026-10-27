import type { ConfigInput } from '../config/schema.js';

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
}

/** Flags that map onto configuration; the schema validates them like any other layer. */
export interface ConfigFlags {
  config?: string;
  title?: string;
}

export function configInputOf(flags: ConfigFlags): ConfigInput {
  return flags.title === undefined ? {} : { title: flags.title };
}
