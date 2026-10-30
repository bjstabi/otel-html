#!/usr/bin/env node
import { spawn } from 'node:child_process';
import * as v8 from 'node:v8';
import { bunEmbeddedViewerAssets, hasBunEmbeddedFiles } from '../writer/viewer-assets.js';
import { runCli } from './program.js';

// The composition root of the CLI: the only place that touches process io and exits.

// Under Node, V8 sizes its heap at several times the live data when allocation is as steady as a large metrics
// convert's (one record per point); favouring size keeps a 72M-point metrics run under 512 MB resident instead of
// about 800 MB, for a run about 40% slower, so metric conversions set that flag as the first points arrive (trace and
// log conversions keep full speed). Receivers (`serve`, `run`) also set it, but alone it makes V8 run a full
// mark-compact about every 0.4 s with pauses up to 200 ms, and a sender's batch queue overflows (spans are dropped)
// when the receiver stalls that long; `--heap-growing-percent=40` cut that to 152 collections with pauses of at most
// 77 ms at 435 MB peak for 1M spans. V8 reads these flags as it goes, so setting them mid-run takes effect. The
// library sets no flags.
const favourHeapSize = (): void => {
  if (!('bun' in process.versions)) v8.setFlagsFromString('--optimize-for-size');
};
const favourShortPauses = (): void => {
  if (!('bun' in process.versions)) v8.setFlagsFromString('--optimize-for-size --heap-growing-percent=40');
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
    favourHeapSize: favourShortPauses,
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
