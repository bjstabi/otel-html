import { type Command, Option } from 'commander';

/** The two ways to say how a writing command treats a report already at `-o`; giving both is a usage error. */
export function addReportModeOptions(command: Command): Command {
  return command
    .addOption(new Option('--append', 'require a report at -o and add to it').conflicts('replace'))
    .addOption(new Option('--replace', 'start the report over').conflicts('append'));
}
