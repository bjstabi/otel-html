import type { Command } from 'commander';
import { merge } from '../../api/convert.js';
import { createNodeFileSystem } from '../../writer/node-fs.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo, ConfigFlags } from '../io.js';
import { resolveCliConfig } from './config-print.js';
import { describeSummary } from './convert.js';

interface MergeFlags extends ConfigFlags {
  out: string;
}

export function addMergeCommand(program: Command, io: CliIo, deps: Partial<WriterDeps>): void {
  program
    .command('merge')
    .description('combine reports into a new one')
    .argument('<reports...>', 'report folders')
    .requiredOption('-o, --out <dir>', 'report folder to write')
    .option('--config <file>', 'config file (default: $OTEL_HTML_CONFIG or ./otel-html.yaml)')
    .action(async (reports: string[], flags: MergeFlags) => {
      const fs = deps.fs ?? createNodeFileSystem();
      const { config } = await resolveCliConfig(io, fs, flags);
      io.stdout(describeSummary(await merge({ inputs: reports, out: flags.out, config }, deps)));
    });
}
