import type { Command } from 'commander';
import { mergeResolved } from '../../api/convert.js';
import { resolveDeps } from '../../api/report.js';
import { createNodeFileSystem } from '../../writer/node-fs.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo, ConfigFlags } from '../io.js';
import { resolveCliConfig } from './config-print.js';
import { describeSummary } from './convert.js';
import { addReportModeOptions } from './report-mode.js';

interface MergeFlags extends ConfigFlags {
  out: string;
}

export function addMergeCommand(program: Command, io: CliIo, deps: Partial<WriterDeps>): void {
  const merge = program
    .command('merge')
    .description('combine reports into one (adds to a report already at -o)')
    .argument('<reports...>', 'report folders')
    .requiredOption('-o, --out <dir>', 'report folder to write or add to')
    .option('--config <file>', 'config file (default: $OTEL_HTML_CONFIG or ./otel-html.yaml)');
  addReportModeOptions(merge).action(async (reports: string[], flags: MergeFlags) => {
    const fs = deps.fs ?? createNodeFileSystem();
    const { config } = await resolveCliConfig(io, fs, flags);
    io.stdout(
      describeSummary(
        await mergeResolved(
          {
            inputs: reports,
            out: flags.out,
            config,
            ...(flags.append === true ? { append: true } : {}),
            ...(flags.replace === true ? { replace: true } : {}),
          },
          await resolveDeps(deps),
        ),
      ),
    );
  });
}
