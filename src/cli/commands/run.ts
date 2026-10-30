import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import { sessionOf } from '../../api/report.js';
import { OtelHtmlError } from '../../model/errors.js';
import { parseUnixNanos, type UnixNanos } from '../../model/ids.js';
import { checkedProtocol, childEnvironment } from '../../run/child-env.js';
import { detectRunResource } from '../../run/resource.js';
import { type ChildExit, exitCodeOf, rootSpanRequest, traceparentOf } from '../../run/root-span.js';
import type { CliIo } from '../io.js';
import { CliExit } from '../program.js';
import {
  addReceiverOptions,
  type CliDeps,
  finishReceiver,
  openReceiver,
  type ReceiveFlags,
} from './receive.js';
import { addReportModeOptions } from './report-mode.js';

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const MS_TO_NS = 1_000_000n;

const randomIds = (): { traceId: Uint8Array; spanId: Uint8Array } => ({
  traceId: randomBytes(TRACE_ID_BYTES),
  spanId: randomBytes(SPAN_ID_BYTES),
});

// Wall-clock time, not the writer's clock: the root span must sit on the same timeline as the child's own spans.
const wallClockNow = (): UnixNanos => parseUnixNanos(BigInt(Date.now()) * MS_TO_NS, 'now');

/** Resolves when the child has exited; rejects when it could not be started at all. */
function exitOf(child: ChildProcess, command: string): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    child.once('error', (e) => {
      // After a successful start an error (a failed kill) is not the end of the child; its exit still follows.
      if (child.pid === undefined) reject(new Error(`cannot run ${command}: ${e.message}`));
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

export function addRunCommand(program: Command, io: CliIo, deps: CliDeps): void {
  const command = program
    .command('run')
    .description('run a command with OTLP pointed at a receiver and wrap it in a root span')
    .argument('<command...>', 'the command and its arguments, after --')
    .passThroughOptions()
    .requiredOption('-o, --out <dir>', 'report folder')
    .option('--config <file>', 'config file (default: $OTEL_HTML_CONFIG or ./otel-html.yaml)')
    .option('--title <title>', 'report title');
  addReceiverOptions(addReportModeOptions(command)).action(async (argv: string[], flags: ReceiveFlags) => {
    const [executable, ...args] = argv;
    if (executable === undefined || executable === '')
      throw new OtelHtmlError('usage', { message: 'no command to run' });
    // Before the receiver opens: once it has returned, only `run`'s own forwarder handles a stop signal, and that is
    // installed after the child starts, so a slow async detector here would leave a window with the lock taken.
    const resource = await detectRunResource(argv);
    const opened = await openReceiver(io, deps, flags, (enabled) => {
      const protocol = checkedProtocol(io.env, enabled); // before anything is created or bound
      // The transport the child will not use stays unbound unless an explicit port flag asked for it.
      if (protocol === 'grpc') return flags.http === undefined ? { http: false } : undefined;
      return flags.grpc === undefined ? { grpc: false } : undefined;
    });
    const { report, receiver } = opened;
    const abandon = async (e: unknown): Promise<never> => {
      await receiver.close().catch(() => undefined);
      await sessionOf(report)
        .abort()
        .catch(() => undefined); // never mask the original error
      throw e;
    };

    const { traceId, spanId } = randomIds();
    let env: Record<string, string | undefined>;
    try {
      env = childEnvironment({
        env: io.env,
        http: receiver.http,
        grpc: receiver.grpc,
        traceparent: traceparentOf(traceId, spanId),
      });
    } catch (e) {
      return abandon(e);
    }
    const { OTEL_EXPORTER_OTLP_ENDPOINT: userEndpoint } = io.env;
    if (userEndpoint !== undefined) {
      io.stderr(
        `warning: OTEL_EXPORTER_OTLP_ENDPOINT is already set (${userEndpoint}); the command will not send to this receiver\n`,
      );
    }

    let child: ChildProcess;
    let exit: ChildExit;
    let start: UnixNanos;
    try {
      start = wallClockNow();
      child = io.spawn(executable, args, { stdio: 'inherit', env: { ...io.env, ...env } });
    } catch (e) {
      return abandon(e);
    }
    const exiting = exitOf(child, executable);
    const forward = io.signals.on((signal) => {
      child.kill(signal);
    });
    try {
      exit = await exiting;
    } catch (e) {
      return abandon(e);
    } finally {
      forward();
    }
    const end = wallClockNow();

    const code = exitCodeOf(exit);
    try {
      await finishReceiver(io, opened, async () => {
        await report.addSpans(
          rootSpanRequest({
            traceId,
            spanId,
            command: argv,
            pid: child.pid ?? 0,
            start,
            end,
            exit,
            resource,
          }),
        );
      });
    } catch (e) {
      // The command's own failure outranks a report failure, but the report failure is still told.
      if (code === 0 || e instanceof CliExit) throw e;
      io.stderr(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      throw new CliExit(code);
    }
    if (code !== 0) throw new CliExit(code);
  });
}
