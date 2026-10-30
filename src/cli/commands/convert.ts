import { type Command, Option } from 'commander';
import { convertResolved } from '../../api/convert.js';
import { resolveDeps } from '../../api/report.js';
import type { OtlpSignal } from '../../model/otlp-json.js';
import { createNodeFileSystem } from '../../writer/node-fs.js';
import type { ReportSummary, WriterDeps } from '../../writer/session.js';
import type { CliIo, ConfigFlags } from '../io.js';
import { resolveCliConfig } from './config-print.js';
import { addReportModeOptions } from './report-mode.js';

const SIGNALS: readonly OtlpSignal[] = ['traces', 'logs', 'metrics'];
const COUNT = new Intl.NumberFormat('en-US');

export function describeSummary(s: ReportSummary): string {
  const { spans, logs, metrics } = s.totals;
  return `wrote ${s.out}: ${COUNT.format(spans)} spans, ${COUNT.format(logs)} logs, ${COUNT.format(metrics)} metric points\n`;
}

interface ConvertFlags extends ConfigFlags {
  out: string;
  signal?: OtlpSignal;
}

export function addConvertCommand(program: Command, io: CliIo, deps: Partial<WriterDeps>): void {
  const convert = program
    .command('convert')
    .description('turn OTLP files (JSON, JSON lines, protobuf) into a report')
    .argument('[files...]', 'OTLP input files')
    .requiredOption('-o, --out <dir>', 'report folder')
    .option('--config <file>', 'config file (default: $OTEL_HTML_CONFIG or ./otel-html.yaml)')
    .option('--title <title>', 'report title')
    .addOption(
      new Option('--signal <signal>', 'signal of protobuf (.pb) inputs, which do not say').choices(SIGNALS),
    );
  addReportModeOptions(convert).action(async (files: string[], flags: ConvertFlags) => {
    const fs = deps.fs ?? createNodeFileSystem();
    const { config } = await resolveCliConfig(io, fs, flags);
    const summary = await convertResolved(
      {
        input: files,
        out: flags.out,
        config,
        ...(flags.append === true ? { append: true } : {}),
        ...(flags.replace === true ? { replace: true } : {}),
        ...(flags.signal === undefined ? {} : { signal: flags.signal }),
      },
      await resolveDeps(deps),
    );
    io.stdout(describeSummary(summary));
  });
}
