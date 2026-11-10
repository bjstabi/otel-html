import { type Command, InvalidArgumentError, Option } from 'commander';
import { type ReceiverOverrides, type RunningReceiver, startReceiverWith } from '../../api/receiver.js';
import { createResolvedReport, type Report, resolveDeps } from '../../api/report.js';
import { OtelHtmlError } from '../../model/errors.js';
import { createForwarder, type Forwarder, parseOtlpHeaders } from '../../receiver/forward.js';
import type { ReceiverStats } from '../../receiver/receiver.js';
import { createNodeFileSystem } from '../../writer/node-fs.js';
import type { CliIo, ReceiverFlags } from '../io.js';
import { type CliDeps, CliExit } from '../program.js';
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
    .option('--no-grpc', 'do not listen for OTLP/gRPC')
    .option(
      '--export-otlp <url>',
      'also forward every accepted request to this OTLP/HTTP collector (headers from OTEL_EXPORTER_OTLP_HEADERS)',
    );
}

export interface ReceiveFlags extends ReceiverFlags {
  out: string;
}

export interface OpenReceiver {
  report: Report;
  receiver: RunningReceiver;
  /** Set when requests are forwarded to a collector; `finishReceiver` closes it after the report's last additions. */
  forwarder?: Forwarder;
}

/** gRPC fan-out is a follow-up; asking for it with forwarding configured is refused rather than silently sent as HTTP. */
const FORWARDABLE_PROTOCOLS: readonly string[] = ['http/protobuf', 'http/json'];

const GRPC_FANOUT_ISSUE = 'https://github.com/bjstabi/otel-html/issues/259';

/**
 * Resolve config, open the report and bind the transports; a failed bind or a stop signal during start-up aborts the
 * report and releases its lock.
 */
export async function openReceiver(
  io: CliIo,
  deps: CliDeps,
  flags: ReceiveFlags,
  /** Runs on the resolved transports before the report is created or a port is bound; throw to stop, or return overrides for the receiver. */
  precheck: (enabled: { http: boolean; grpc: boolean }) => ReceiverOverrides | undefined = () => undefined,
): Promise<OpenReceiver> {
  const fs = deps.fs ?? createNodeFileSystem();
  const { config } = await resolveCliConfig(io, fs, flags);
  // The flags are already merged into the config, so this is the rule startReceiver applies.
  if (!config.receiver.http.enabled && !config.receiver.grpc.enabled) {
    throw new OtelHtmlError('usage', {
      message: 'no receiver transport enabled',
      hint: 'enable http or grpc',
    });
  }
  const exportOtlp = config.receiver.exportOtlp;
  const { OTEL_EXPORTER_OTLP_PROTOCOL: protocol, OTEL_EXPORTER_OTLP_HEADERS: headerText } = io.env;
  if (exportOtlp !== undefined && protocol !== undefined && !FORWARDABLE_PROTOCOLS.includes(protocol)) {
    const grpc = protocol === 'grpc';
    throw new OtelHtmlError('usage', {
      message: grpc
        ? 'forwarding over gRPC is not supported: OTEL_EXPORTER_OTLP_PROTOCOL=grpc with --export-otlp / receiver.exportOtlp'
        : `OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} cannot be combined with --export-otlp / receiver.exportOtlp`,
      hint: `use http/protobuf or http/json${grpc ? ` (gRPC fan-out is tracked in ${GRPC_FANOUT_ISSUE})` : ''}`,
    });
  }
  const headers = exportOtlp === undefined ? {} : parseOtlpHeaders(headerText);
  const overrides = precheck({ http: config.receiver.http.enabled, grpc: config.receiver.grpc.enabled });
  const full = await resolveDeps(deps);
  const forwarder: Forwarder | undefined =
    exportOtlp === undefined
      ? undefined
      : createForwarder({ endpoint: exportOtlp, headers, logger: full.logger });
  // Installed before the lock is taken, so a stop signal during start-up is handled rather than left to the default.
  const stop = nextSignal(io);
  const interrupted = stop.signalled.then((): never => {
    io.stdout('interrupted\n');
    throw new CliExit(INTERRUPTED_EXIT);
  });
  interrupted.catch(() => undefined); // only observed through the race below
  const creating = createResolvedReport(
    {
      out: flags.out,
      ...(flags.append === true ? { append: true } : {}),
      ...(flags.replace === true ? { replace: true } : {}),
    },
    config,
    full,
  );
  creating.catch(() => undefined); // its own failure is reported by the race, or dropped after a signal
  let starting: Promise<RunningReceiver> | undefined;
  let again: ReturnType<typeof nextSignal> | undefined;
  try {
    const report = await Promise.race([creating, interrupted]);
    starting = startReceiverWith(report, { ...overrides, ...(forwarder === undefined ? {} : { forwarder }) });
    starting.catch(() => undefined);
    const receiver = await Promise.race([starting, interrupted]);
    return { report, receiver, ...(forwarder === undefined ? {} : { forwarder }) };
  } catch (e) {
    // Whatever the start leaves behind once it settles: its bound ports and the report's lock.
    const cleanup = (async () => {
      const report = await creating.catch(() => undefined);
      const receiver = await starting?.catch(() => undefined);
      await receiver?.close().catch(() => undefined);
      if (report !== undefined) await report.abort().catch(() => undefined); // never mask the original error
    })();
    // Wait for the lock release before exiting, so the process does not leave it behind. A second signal exits
    // without waiting and may leave the lock behind; the dead-pid check reclaims it on the next start.
    again = nextSignal(io);
    const signalled = await Promise.race([cleanup.then(() => false), again.signalled.then(() => true)]);
    // `stop` is still subscribed here, so it has already printed "interrupted" for this signal.
    if (signalled) throw new CliExit(INTERRUPTED_EXIT);
    throw e;
  } finally {
    again?.cancel();
    stop.cancel();
  }
}

/** Resolves on the next stop signal; `cancel` unsubscribes without resolving. */
export function nextSignal(io: CliIo): { signalled: Promise<void>; cancel: () => void } {
  let off = (): void => undefined;
  const signalled = new Promise<void>((resolve) => {
    off = io.signals.on(() => {
      off();
      resolve();
    });
  });
  return { signalled, cancel: () => off() };
}

/**
 * Stop listening, drain, run `beforeClose` (it may still add to the report), close the report and print the totals.
 * A stop signal while this runs ends it at once with 130, leaving the report at its last checkpoint.
 */
export async function finishReceiver(
  io: CliIo,
  { report, receiver, forwarder }: OpenReceiver,
  beforeClose: () => Promise<void> = async () => undefined,
): Promise<void> {
  const again = nextSignal(io);
  const second = again.signalled.then(() => {
    io.stdout('interrupted; the report is at its last checkpoint\n');
    throw new CliExit(INTERRUPTED_EXIT);
  });
  const finishing = (async () => {
    try {
      await receiver.close();
      await beforeClose();
      await forwarder?.close(); // after the listeners are closed and the last additions are queued
      return await report.close();
    } catch (e) {
      await report.abort().catch(() => undefined);
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
  io.stdout(`${describeSummary(summary)}${receivedLines(receiver.stats(), forwarder !== undefined)}`);
}

/**
 * Requests and records are different units, so they are named apart: `refused` requests failed (nothing from them
 * was written); `rejected` records were dropped from requests that were otherwise accepted.
 */
function receivedLines(
  { requests, refused, rejected, forwarded, forwardDropped, forwardFailed }: ReceiverStats,
  forwarding: boolean,
): string {
  const refusals = Object.entries(refused).filter(([, n]) => n > 0);
  const refusedTotal = refusals.reduce((sum, [, n]) => sum + n, 0);
  const records = rejected.traces + rejected.logs + rejected.metrics;
  const head = `received ${requests} requests (${refusedTotal} refused); ${records} records rejected\n`;
  const breakdown =
    refusals.length === 0 ? head : `${head}refused: ${refusals.map(([o, n]) => `${n} ${o}`).join(', ')}\n`;
  return forwarding
    ? `${breakdown}forwarded ${forwarded}, dropped ${forwardDropped}, failed ${forwardFailed}\n`
    : breakdown;
}
