import { type Command, InvalidArgumentError, Option } from 'commander';
import { startReceiver } from '../../api/receiver.js';
import { Report, resolveDeps, sessionOf } from '../../api/report.js';
import { OtelHtmlError } from '../../model/errors.js';
import { createNodeFileSystem } from '../../writer/node-fs.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo, ReceiverFlags } from '../io.js';
import { CliExit } from '../program.js';
import { resolveCliConfig } from './config-print.js';
import { describeSummary } from './convert.js';

const MAX_PORT = 65535;
const INTERRUPTED_EXIT = 130;

export function portOf(text: string): number {
  const port = Number(text);
  if (!/^\d+$/.test(text) || port > MAX_PORT) {
    throw new InvalidArgumentError(`${text} is not a port (an integer from 0 to ${MAX_PORT})`);
  }
  return port;
}

/** The receiver options shared by `serve` and `run`. */
export function addReceiverOptions(command: Command): Command {
  return command
    .option('--host <addr>', 'address to listen on (default 127.0.0.1)')
    .addOption(new Option('--http <port>', 'OTLP/HTTP port (default 4318)').argParser(portOf))
    .option('--no-http', 'do not listen for OTLP/HTTP')
    .addOption(new Option('--grpc <port>', 'OTLP/gRPC port (default 4317)').argParser(portOf))
    .option('--no-grpc', 'do not listen for OTLP/gRPC');
}

export interface ServeFlags extends ReceiverFlags {
  out: string;
}

/** Resolves on the next stop signal; `cancel` unsubscribes without resolving. */
function nextSignal(io: CliIo): { signalled: Promise<void>; cancel: () => void } {
  let off = (): void => undefined;
  const signalled = new Promise<void>((resolve) => {
    off = io.signals.on(() => {
      off();
      resolve();
    });
  });
  return { signalled, cancel: () => off() };
}

export function addServeCommand(program: Command, io: CliIo, deps: Partial<WriterDeps>): void {
  const serve = program
    .command('serve')
    .description('receive OTLP over HTTP and gRPC and write a report until Ctrl-C')
    .requiredOption('-o, --out <dir>', 'report folder')
    .option('--config <file>', 'config file (default: $OTEL_HTML_CONFIG or ./otel-html.yaml)')
    .option('--title <title>', 'report title')
    .option('--append', 'add to an existing report instead of replacing it');
  addReceiverOptions(serve).action(async (flags: ServeFlags) => {
    if (flags.http === false && flags.grpc === false) {
      throw new OtelHtmlError('usage', {
        message: 'no receiver transport enabled',
        hint: 'enable http or grpc',
      });
    }
    const fs = deps.fs ?? createNodeFileSystem();
    const { config } = await resolveCliConfig(io, fs, flags);
    const full = await resolveDeps(deps);
    const report = await Report.createResolved(
      { out: flags.out, ...(flags.append === true ? { append: true } : {}) },
      config,
      full,
    );
    let receiver: Awaited<ReturnType<typeof startReceiver>>;
    try {
      receiver = await startReceiver(report, {}, deps);
    } catch (e) {
      await sessionOf(report)
        .abort()
        .catch(() => undefined); // never mask the original error
      throw e;
    }
    const listening = [
      receiver.http === null ? null : `${receiver.http} (OTLP/HTTP)`,
      receiver.grpc === null ? null : `${receiver.grpc} (OTLP/gRPC)`,
    ].filter((a) => a !== null);
    io.stdout(`listening on ${listening.join(' and ')}, writing ${flags.out}; press Ctrl-C to finish\n`);

    await nextSignal(io).signalled;
    const again = nextSignal(io);
    const second = again.signalled.then(() => {
      io.stdout('interrupted; the report is at its last checkpoint\n');
      throw new CliExit(INTERRUPTED_EXIT);
    });
    const finishing = (async () => {
      try {
        await receiver.close();
        return await report.close();
      } catch (e) {
        await sessionOf(report)
          .abort()
          .catch(() => undefined);
        throw e;
      }
    })();
    finishing.catch(() => undefined); // a failure after the second signal has no one left to tell
    let summary: Awaited<typeof finishing>;
    try {
      summary = await Promise.race([finishing, second]);
    } finally {
      again.cancel();
    }
    const { requests, rejected } = receiver.stats();
    const refused = rejected.traces + rejected.logs + rejected.metrics;
    io.stdout(`${describeSummary(summary)}received ${requests} requests (${refused} rejected)\n`);
  });
}
