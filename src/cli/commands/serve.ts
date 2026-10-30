import type { Command } from 'commander';
import type { CliIo } from '../io.js';
import {
  addReceiverOptions,
  type CliDeps,
  finishReceiver,
  nextSignal,
  openReceiver,
  type ReceiveFlags,
} from './receive.js';
import { addReportModeOptions } from './report-mode.js';

export function addServeCommand(program: Command, io: CliIo, deps: CliDeps): void {
  const serve = program
    .command('serve')
    .description('receive OTLP over HTTP and gRPC and write a report until Ctrl-C')
    .requiredOption('-o, --out <dir>', 'report folder')
    .option('--config <file>', 'config file (default: $OTEL_HTML_CONFIG or ./otel-html.yaml)')
    .option('--title <title>', 'report title');
  addReceiverOptions(addReportModeOptions(serve)).action(async (flags: ReceiveFlags) => {
    const opened = await openReceiver(io, deps, flags);
    const { receiver } = opened;
    const listening = [
      receiver.http === null ? null : `${receiver.http} (OTLP/HTTP)`,
      receiver.grpc === null ? null : `${receiver.grpc} (OTLP/gRPC)`,
    ].filter((a) => a !== null);
    io.stdout(`listening on ${listening.join(' and ')}, writing ${flags.out}; press Ctrl-C to finish\n`);

    await nextSignal(io).signalled;
    await finishReceiver(io, opened);
  });
}
