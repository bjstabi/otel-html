import { type Command, Option } from 'commander';
import pkg from '../../../package.json' with { type: 'json' };
import { resolveDeps } from '../../api/report.js';
import { createNodeFileSystem } from '../../writer/node-fs.js';
import type { WriterDeps } from '../../writer/session.js';
import { upgradeReport } from '../../writer/upgrade.js';
import type { CliIo } from '../io.js';
import { resolveCliConfig } from './config-print.js';

export function addUpgradeCommand(program: Command, io: CliIo, deps: Partial<WriterDeps>): void {
  program
    .command('upgrade')
    .description("rewrite a report's viewer with this version's, leaving its data alone")
    .argument('<report>', 'report folder')
    .addOption(
      new Option('--format <format>', 'format-4 report: switch it to local or site').choices([
        'local',
        'site',
      ]),
    )
    .option(
      '--assets-base <path>',
      'format-4 report: load the viewer files from assets/ or a relative path like ../../assets/0.3.0/',
    )
    .option('--config <file>', 'config file, read for writer.localWarnBytes with --format local')
    .action(
      async (report: string, flags: { format?: 'local' | 'site'; assetsBase?: string; config?: string }) => {
        // Only the size warning of a switch to local needs the configuration; any other upgrade ignores it.
        const localWarnBytes =
          flags.format === 'local'
            ? (
                await resolveCliConfig(io, deps.fs ?? createNodeFileSystem(), {
                  format: 'local',
                  ...(flags.config === undefined ? {} : { config: flags.config }),
                })
              ).config.writer.localWarnBytes
            : undefined;
        const { formatVersion } = await upgradeReport(await resolveDeps(deps), report, {
          ...(localWarnBytes === undefined ? {} : { localWarnBytes }),
          ...(flags.format === undefined ? {} : { format: flags.format }),
          ...(flags.assetsBase === undefined ? {} : { assetsBase: flags.assetsBase }),
        });
        io.stdout(`upgraded ${report}: viewer ${pkg.version}, format ${formatVersion}\n`);
      },
    );
}
