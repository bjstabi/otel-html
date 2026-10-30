#!/usr/bin/env node
import { spawn } from 'node:child_process';
import * as v8 from 'node:v8';
import { bunEmbeddedViewerAssets, hasBunEmbeddedFiles } from '../writer/viewer-assets.js';
import { runCli } from './program.js';

// The composition root of the CLI: the only place that touches process io and exits.

// Under Node, V8 sizes its heap at several times the live data when allocation is steady. A receiver (`serve`, `run`)
// sets `--optimize-for-size --heap-growing-percent=40` before it runs: the first keeps memory low, the second keeps
// full-GC pauses short so a sender's batch queue does not overflow (#73 measured 473 MB when set at start-up against
// 524 MB when set mid-run). The library sets no flags.
const command = process.argv.slice(2).find((a) => !a.startsWith('-'));
if ((command === 'serve' || command === 'run') && !('bun' in process.versions)) {
  v8.setFlagsFromString('--optimize-for-size --heap-growing-percent=40');
}
// Metric conversions set the size flag as the first points arrive (a 72M-point run stays under 512 MB, about 40%
// slower); trace and log conversions keep full speed.
const favourHeapSize = (): void => {
  if (!('bun' in process.versions)) v8.setFlagsFromString('--optimize-for-size');
};

const code = await runCli(
  process.argv.slice(2),
  {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
    signals: {
      on(fn) {
        const sigint = (): void => fn('SIGINT');
        const sigterm = (): void => fn('SIGTERM');
        process.on('SIGINT', sigint);
        process.on('SIGTERM', sigterm);
        return () => {
          process.off('SIGINT', sigint);
          process.off('SIGTERM', sigterm);
        };
      },
    },
    spawn,
  },
  // Inside a `bun build --compile` binary the viewer ships embedded; under Node it is read from the package.
  {
    beforeMetrics: favourHeapSize,
    ...(hasBunEmbeddedFiles() ? { viewerAssets: bunEmbeddedViewerAssets() } : {}),
  },
);
process.exitCode = code;
// A failing command must end the process even if something (a bound server) still holds the event loop; an
// interrupted `serve` may still be finishing its report, and a second Ctrl-C means stop now, at the last checkpoint.
// This safety net is not unit-testable without a build (main.ts runs on import). The binary smoke test covers it:
// its `serve` + SIGINT path (exit 0, the net is skipped) and its bad-port test (non-zero, the net ends the process).
if (code !== 0) {
  const flushed = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((resolve) => stream.write('', () => resolve()));
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}
