import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OtelHtmlError } from '../../model/errors.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import { uploadArtifact } from './artifact-client.js';
import { LOG_FILE } from './ledger.js';
import { runPusher } from './pusher.js';

export interface PusherCommand {
  report: string;
  every: string;
  config?: string;
  deployerWorkflow: string;
  detached: boolean;
}

/** `60s`, `2m`, `500ms` (whole numbers); anything else is a usage error. */
export function parseEvery(text: string): number {
  const m = /^(\d+)(ms|s|m)$/.exec(text);
  const n = m === null ? 0 : Number(m[1]);
  if (m === null || n <= 0)
    throw new OtelHtmlError('usage', { message: `--every is not a duration like 60s, 2m or 500ms: ${text}` });
  return m[2] === 'ms' ? n : m[2] === 's' ? n * 1_000 : n * 60_000;
}

/**
 * `ci pusher`: without `--detached` it re-spawns itself detached, its output in `<report>/../publish/pusher.log`,
 * and returns at once; with it, it runs the pusher loop (the child).
 */
export async function runPusherCommand(o: PusherCommand, io: CliIo, deps: WriterDeps): Promise<void> {
  const everyMs = parseEvery(o.every);
  const report = resolve(io.cwd, o.report);
  const publishDir = join(dirname(report), 'publish');
  if (!o.detached) {
    mkdirSync(publishDir, { recursive: true });
    const args = [
      'ci',
      'pusher',
      '--report',
      o.report,
      '--every',
      o.every,
      ...(o.config === undefined ? [] : ['--config', o.config]),
      '--deployer-workflow',
      o.deployerWorkflow,
      '--detached',
    ];
    const logFd = openSync(join(publishDir, LOG_FILE), 'a');
    try {
      const bun = 'bun' in process.versions;
      const child = io.spawn(process.execPath, bun ? args : [process.argv[1] ?? '', ...args], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: io.env,
        windowsHide: true,
      });
      child.unref();
    } finally {
      closeSync(logFd);
    }
    return;
  }
  await runPusher(
    {
      report,
      publishDir,
      everyMs,
      ...(o.config === undefined ? {} : { config: o.config }),
      env: io.env,
      deployerWorkflow: o.deployerWorkflow,
    },
    {
      fs: deps.fs,
      clock: deps.clock,
      sleep: (ms) =>
        new Promise((r) => {
          deps.timers.after(ms, r);
        }),
      upload: uploadArtifact,
      fetchFn: fetch,
      log: (line) => io.stdout(`${line}\n`),
      deps,
    },
    io.signals,
  );
}
