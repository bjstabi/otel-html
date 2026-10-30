import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import { sessionOf } from '../../api/report.js';
import { OtelHtmlError } from '../../model/errors.js';
import { parseUnixNanos, type UnixNanos } from '../../model/ids.js';
import { childEnvironment } from '../../run/child-env.js';
import { detectRunResource } from '../../run/resource.js';
import { type ChildExit, exitCodeOf, rootSpanRequest, traceparentOf } from '../../run/root-span.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import { CliExit } from '../program.js';
import { addReceiverOptions, finishReceiver, openReceiver, type ReceiveFlags } from './receive.js';

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const MS_TO_NS = 1_000_000n;

export interface RunDeps {
  ids?: () => { traceId: Uint8Array; spanId: Uint8Array };
  now?: () => UnixNanos;
}

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

export function addRunCommand(
  program: Command,
  io: CliIo,
  deps: Partial<WriterDeps>,
  run: RunDeps = {},
): void {
  const command = program
    .command('run')
    .description('run a command with OTLP pointed at a receiver and wrap it in a root span')
    .argument('<command...>', 'the command and its arguments, after --')
    .passThroughOptions()
    .requiredOption('-o, --out <dir>', 'report folder')
    .option('--config <file>', 'config file (default: $OTEL_HTML_CONFIG or ./otel-html.yaml)')
    .option('--title <title>', 'report title');
  addReceiverOptions(command).action(async (argv: string[], flags: ReceiveFlags) => {
    const [executable, ...args] = argv;
    if (executable === undefined) throw new OtelHtmlError('usage', { message: 'no command to run' });
    const opened = await openReceiver(io, deps, flags);
    const { report, receiver } = opened;
    const abandon = async (e: unknown): Promise<never> => {
      await receiver.close().catch(() => undefined);
      await sessionOf(report)
        .abort()
        .catch(() => undefined); // never mask the original error
      throw e;
    };

    const { traceId, spanId } = (run.ids ?? randomIds)();
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

    const resource = await detectRunResource(argv);
    const now = run.now ?? wallClockNow;
    const start = now();
    const child = io.spawn(executable, args, { stdio: 'inherit', env: { ...io.env, ...env } });
    const exiting = exitOf(child, executable);
    const forward = io.signals.on((signal) => {
      child.kill(signal);
    });
    let exit: ChildExit;
    try {
      exit = await exiting;
    } catch (e) {
      return abandon(e);
    } finally {
      forward();
    }
    const end = now();

    await finishReceiver(io, opened, async () => {
      await report.addSpans(
        rootSpanRequest({ traceId, spanId, command: argv, pid: child.pid ?? 0, start, end, exit, resource }),
      );
    });
    const code = exitCodeOf(exit);
    if (code !== 0) throw new CliExit(code);
  });
}
