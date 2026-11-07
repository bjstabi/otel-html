import { type Command, Option } from 'commander';

/** The two ways to say how a writing command treats a report already at `-o`; giving both is a usage error. */
export function addReportModeOptions(command: Command): Command {
  return command
    .addOption(new Option('--append', 'require a report at -o and add to it').conflicts('replace'))
    .addOption(new Option('--replace', 'start the report over').conflicts('append'));
}

/** `--format` and `--assets-base`, which map onto `writer.format` and `writer.assetsBase` (the schema validates the base). */
export function addReportFormatOptions(command: Command): Command {
  return command
    .addOption(
      new Option('--format <format>', 'report format to write (default chunks)').choices([
        'chunks',
        'local',
        'site',
      ]),
    )
    .option('--assets-base <path>', 'load the viewer files from this relative path (default assets/)');
}
