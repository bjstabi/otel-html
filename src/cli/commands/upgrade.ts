import { type Command, Option } from 'commander';
import pkg from '../../../package.json' with { type: 'json' };
import { resolveDeps } from '../../api/report.js';
import type { WriterDeps } from '../../writer/session.js';
import { upgradeReport } from '../../writer/upgrade.js';
import type { CliIo } from '../io.js';

export function addUpgradeCommand(program: Command, io: CliIo, deps: Partial<WriterDeps>): void {
  program
    .command('upgrade')
    .description("rewrite a report's viewer with this version's, leaving its data alone")
    .argument('<report>', 'report folder')
    .addOption(
      new Option('--format <format>', 'a report: switch it to local or site').choices(['local', 'site']),
    )
    .option(
      '--assets-base <path>',
      'a report: load the viewer files from assets/ or a relative path like ../../assets/0.3.0/',
    )
    .action(async (report: string, flags: { format?: 'local' | 'site'; assetsBase?: string }) => {
      const { formatVersion } = await upgradeReport(await resolveDeps(deps), report, {
        ...(flags.format === undefined ? {} : { format: flags.format }),
        ...(flags.assetsBase === undefined ? {} : { assetsBase: flags.assetsBase }),
      });
      io.stdout(`upgraded ${report}: viewer ${pkg.version}, format ${formatVersion}\n`);
    });
}
