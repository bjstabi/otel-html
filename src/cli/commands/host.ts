import { type Command, InvalidArgumentError, Option } from 'commander';
import { resolveDeps } from '../../api/report.js';
import { type HostEngine, HUNG_GRACE_MS, startHostEngine } from '../../host/engine.js';
import { type HostEngineFiles, hostEngineFiles } from '../../host/engine-files.js';
import { readHostManifest } from '../../host/manifest.js';
import { startHostServer } from '../../host/server.js';
import type { Listener } from '../../receiver/http.js';
import type { CliIo } from '../io.js';
import { type CliDeps, CliExit } from '../program.js';
import { nextSignal, portOf } from './receive.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_BYTES = 67_108_864;
/** 24 hours; with the grace for a silent worker it stays far below the 2^31 - 1 ms a Node timer can hold. */
const MAX_TIMEOUT_MS = 86_400_000;
/** 4 GiB of Arrow IPC held for one result. */
const MAX_RESULT_BYTES = 4_294_967_296;
const BYTES_PER_MB = 1_000_000;

if (MAX_TIMEOUT_MS + HUNG_GRACE_MS > 2_147_483_647) throw new Error('--timeout bound overflows a Node timer');

function boundedInt(max: number): (text: string) => number {
  return (text) => {
    const n = Number(text);
    if (!/^\d+$/.test(text) || n < 1 || n > max) {
      throw new InvalidArgumentError(`${text} is not an integer from 1 to ${max}`);
    }
    return n;
  };
}

interface HostFlags {
  host: string;
  port: number;
  timeout: number;
  maxResultBytes: number;
}

const INTERRUPTED_EXIT = 130;
/** How long in-flight responses get to flush, once the engine has answered them 503, before connections are cut. */
const DRAIN_MS = 500;

interface Running {
  files?: HostEngineFiles | undefined;
  engine?: HostEngine | undefined;
  listener?: Listener | undefined;
}

/**
 * Stops promptly whatever the statements are doing: no new connections, the engine closed (running and queued
 * statements are answered 503), what is still connected cut, then the files the engine ran from. A second stop signal
 * while this runs removes the files and exits 130 without waiting for the rest.
 */
async function shutdown(io: CliIo, running: Running): Promise<void> {
  const again = nextSignal(io);
  const closing = (async () => {
    const listening = running.listener?.close().catch(() => undefined);
    await running.engine?.close().catch(() => undefined);
    if (listening !== undefined) {
      const drained = new Promise<void>((done) => setTimeout(done, DRAIN_MS).unref());
      await Promise.race([listening, drained]);
      running.listener?.closeConnections?.();
      await listening;
    }
    await running.files?.close().catch(() => undefined);
  })();
  closing.catch(() => undefined);
  try {
    const second = await Promise.race([closing.then(() => false), again.signalled.then(() => true)]);
    if (second) {
      await running.files?.close().catch(() => undefined);
      io.stdout('interrupted\n');
      throw new CliExit(INTERRUPTED_EXIT);
    }
  } finally {
    again.cancel();
  }
}

/** The second stop signal during start-up: close what exists now and what `starting` leaves when it settles; 130. */
async function abandon(io: CliIo, running: Running, starting: Promise<unknown>): Promise<never> {
  const had = { ...running };
  const late = (async () => {
    await starting.catch(() => undefined);
    const rest: Running = {};
    if (running.listener !== had.listener) rest.listener = running.listener;
    if (running.engine !== had.engine) rest.engine = running.engine;
    if (running.files !== had.files) rest.files = running.files;
    await closeAllOf(rest);
  })();
  late.catch(() => undefined); // the process may exit first; a late engine dies with it
  await closeAllOf(had);
  io.stdout('interrupted\n');
  throw new CliExit(INTERRUPTED_EXIT);
}

async function closeAllOf(r: Running): Promise<void> {
  r.listener?.closeConnections?.();
  await r.listener?.close().catch(() => undefined);
  await r.engine?.close().catch(() => undefined);
  await r.files?.close().catch(() => undefined);
}

async function serveReport(io: CliIo, deps: CliDeps, report: string, flags: HostFlags): Promise<void> {
  const full = await resolveDeps(deps);
  const manifest = await readHostManifest(full.fs, report);
  // Subscribed before anything starts, so a signal during start-up is not left to the default handler.
  const stop = nextSignal(io);
  const running: Running = {};
  const starting = (async () => {
    running.files = await hostEngineFiles();
    running.engine = await startHostEngine({
      report,
      manifest: manifest.manifest,
      files: running.files,
      fs: full.fs,
      logger: full.logger,
      timeoutMs: flags.timeout,
      maxResultBytes: flags.maxResultBytes,
    });
    running.listener = await startHostServer({
      report,
      manifest,
      engine: running.engine,
      viewerAssets: full.viewerAssets,
      host: flags.host,
      port: flags.port,
      logger: full.logger,
      tracer: full.tracer,
    });
    return running.listener;
  })();
  starting.catch(() => undefined); // observed through the race below, or dropped after a signal
  let listener: Listener;
  try {
    const first = await Promise.race([starting, stop.signalled.then(() => undefined)]);
    if (first === undefined) {
      // Stopped during start-up: let what is starting settle, then close it. A second signal ends the wait: what
      // exists is closed now, whatever start-up still produces when it settles is closed then, and the exit is 130.
      const again = nextSignal(io);
      const second = await Promise.race([
        starting.then(
          () => false,
          () => false,
        ),
        again.signalled.then(() => true),
      ]);
      again.cancel();
      if (second) await abandon(io, running, starting);
      await shutdown(io, running);
      return;
    }
    listener = first;
  } catch (e) {
    stop.cancel();
    await shutdown(io, running);
    throw e;
  }
  const n = manifest.manifest.partitions.length;
  const mb = Math.round(manifest.partitionBytes / BYTES_PER_MB);
  io.stdout(
    `serving ${report} at ${listener.address}/ (${n} ${n === 1 ? 'partition' : 'partitions'}, ${mb} MB of Parquet); press Ctrl-C to stop\n`,
  );
  await stop.signalled;
  await shutdown(io, running);
}

export function addHostCommand(program: Command, io: CliIo, deps: CliDeps): void {
  program
    .command('host')
    .description('serve a format-5 report over HTTP, answering its queries with DuckDB until Ctrl-C')
    .argument('<report>', 'report folder')
    .option('--host <addr>', 'address to listen on', DEFAULT_HOST)
    .addOption(
      new Option('--port <port>', 'port to listen on; 0 picks a free one')
        .argParser(portOf)
        .default(DEFAULT_PORT),
    )
    .addOption(
      new Option('--timeout <ms>', `statement timeout in milliseconds (1 to ${MAX_TIMEOUT_MS})`)
        .argParser(boundedInt(MAX_TIMEOUT_MS))
        .default(DEFAULT_TIMEOUT_MS),
    )
    .addOption(
      new Option(
        '--max-result-bytes <n>',
        `largest result of one statement, in bytes (1 to ${MAX_RESULT_BYTES})`,
      )
        .argParser(boundedInt(MAX_RESULT_BYTES))
        .default(DEFAULT_MAX_RESULT_BYTES),
    )
    .action(async (report: string, flags: HostFlags) => {
      await serveReport(io, deps, report, flags);
    });
}
