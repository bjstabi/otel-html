import { type Command, Option } from 'commander';
import { convert } from '../../api/convert.js';
import type { OtlpSignal } from '../../model/otlp-json.js';
import { createNodeFileSystem } from '../../writer/node-fs.js';
import type { ReportSummary, WriterDeps } from '../../writer/session.js';
import type { CliIo, ConfigFlags } from '../io.js';
import { resolveCliConfig } from './config-print.js';

const SIGNALS: readonly OtlpSignal[] = ['traces', 'logs', 'metrics'];
const COUNT = new Intl.NumberFormat('en-US');

export function describeSummary(s: ReportSummary): string {
  const { spans, logs, metrics } = s.totals;
  return `wrote ${s.out}: ${COUNT.format(spans)} spans, ${COUNT.format(logs)} logs, ${COUNT.format(metrics)} metric points\n`;
}

interface ConvertFlags extends ConfigFlags {
  out: string;
  append?: boolean;
  signal?: OtlpSignal;
}

export function addConvertCommand(program: Command, io: CliIo, deps: Partial<WriterDeps>): void {
  program
    .command('convert')
    .description('turn OTLP files (JSON, JSON lines, protobuf) into a report')
    .argument('[files...]', 'OTLP input files')
    .requiredOption('-o, --out <dir>', 'report folder')
    .option('--config <file>', 'config file (default: $OTEL_HTML_CONFIG or ./otel-html.yaml)')
    .option('--title <title>', 'report title')
    .option('--append', 'add to an existing report instead of replacing it')
    .addOption(
      new Option('--signal <signal>', 'signal of protobuf (.pb) inputs, which do not say').choices(SIGNALS),
    )
    .action(async (files: string[], flags: ConvertFlags) => {
      const fs = deps.fs ?? createNodeFileSystem();
      const { config } = await resolveCliConfig(io, fs, flags);
      const summary = await convert(
        {
          input: files,
          out: flags.out,
          config,
          ...(flags.append === true ? { append: true } : {}),
          ...(flags.signal === undefined ? {} : { signal: flags.signal }),
        },
        deps,
      );
      io.stdout(describeSummary(summary));
    });
}
