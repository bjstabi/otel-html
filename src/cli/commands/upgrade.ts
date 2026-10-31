import type { Command } from 'commander';
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
    .action(async (report: string) => {
      const { formatVersion } = await upgradeReport(await resolveDeps(deps), report);
      io.stdout(`upgraded ${report}: viewer ${pkg.version}, format ${formatVersion}\n`);
    });
}
