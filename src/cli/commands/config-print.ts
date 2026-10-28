import { basename } from 'node:path';
import type { Command } from 'commander';
import { findConfigPath, loadConfigFile } from '../../config/load.js';
import { formatConfig, type ResolveResult, resolveConfig } from '../../config/resolve.js';
import { createNodeFileSystem } from '../../writer/node-fs.js';
import type { FileSystem } from '../../writer/ports.js';
import { type CliIo, type ConfigFlags, configInputOf } from '../io.js';

/** defaults < config file (`--config`, OTEL_HTML_CONFIG or ./otel-html.yaml) < environment < flags. */
export async function resolveCliConfig(
  io: CliIo,
  fs: FileSystem,
  flags: ConfigFlags,
): Promise<ResolveResult> {
  const path = flags.config ?? (await findConfigPath(fs, io.cwd, io.env));
  const file = path === null ? undefined : await loadConfigFile(fs, path);
  return resolveConfig({
    ...(file === undefined || path === null ? {} : { file, fileLabel: basename(path) }),
    env: io.env,
    flags: configInputOf(flags),
  });
}

export function addConfigCommand(program: Command, io: CliIo, fs: FileSystem = createNodeFileSystem()): void {
  const config = program.command('config').description('inspect configuration');
  config
    .command('print')
    .description('print the resolved configuration and where each value came from')
    .option('--config <file>', 'config file (default: $OTEL_HTML_CONFIG or ./otel-html.yaml)')
    .option('--title <title>', 'report title')
    .action(async (flags: ConfigFlags) => {
      io.stdout(formatConfig(await resolveCliConfig(io, fs, flags)));
    });
}
