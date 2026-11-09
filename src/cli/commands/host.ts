import { type Command, InvalidArgumentError, Option } from 'commander';
import { resolveDeps } from '../../api/report.js';
import { type HostEngine, HUNG_GRACE_MS, startHostEngine } from '../../host/engine.js';
import { type HostEngineFiles, hostEngineFiles } from '../../host/engine-files.js';
import { readHostManifest } from '../../host/manifest.js';
import { startHostServer } from '../../host/server.js';
import type { Listener } from '../../receiver/http.js';
import type { CliIo } from '../io.js';
import type { CliDeps } from '../program.js';
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

async function serveReport(io: CliIo, deps: CliDeps, report: string, flags: HostFlags): Promise<void> {
  const full = await resolveDeps(deps);
  const manifest = await readHostManifest(full.fs, report);
  // Subscribed before anything starts, so a signal during start-up is not left to the default handler.
  const stop = nextSignal(io);
  let files: HostEngineFiles | undefined;
  let engine: HostEngine | undefined;
  let listener: Listener | undefined;
  const closeAll = async (): Promise<void> => {
    // Server first (no new queries), then the engine, then the files it ran from.
    await listener?.close().catch(() => undefined);
    await engine?.close().catch(() => undefined);
    await files?.close().catch(() => undefined);
  };
  try {
    files = await hostEngineFiles();
    engine = await startHostEngine({
      report,
      manifest: manifest.manifest,
      files,
      fs: full.fs,
      logger: full.logger,
      timeoutMs: flags.timeout,
      maxResultBytes: flags.maxResultBytes,
    });
    listener = await startHostServer({
      report,
      manifest,
      engine,
      viewerAssets: full.viewerAssets,
      host: flags.host,
      port: flags.port,
      logger: full.logger,
      tracer: full.tracer,
    });
  } catch (e) {
    stop.cancel();
    await closeAll();
    throw e;
  }
  const n = manifest.manifest.partitions.length;
  const mb = Math.round(manifest.partitionBytes / BYTES_PER_MB);
  io.stdout(
    `serving ${report} at ${listener.address}/ (${n} partitions, ${mb} MB of Parquet); press Ctrl-C to stop\n`,
  );
  await stop.signalled;
  await closeAll();
}

export function addHostCommand(program: Command, io: CliIo, deps: CliDeps): void {
  program
    .command('host')
    .description('serve a format-4 report over HTTP, answering its queries with DuckDB until Ctrl-C')
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
