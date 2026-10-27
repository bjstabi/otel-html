#!/usr/bin/env node
import { bunEmbeddedViewerAssets, hasBunEmbeddedFiles } from '../writer/viewer-assets.js';
import { runCli } from './program.js';

// The composition root of the CLI: the only place that touches process io and exits.
process.exitCode = await runCli(
  process.argv.slice(2),
  {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
  },
  // Inside a `bun build --compile` binary the viewer ships embedded; under Node it is read from the package.
  hasBunEmbeddedFiles() ? { viewerAssets: bunEmbeddedViewerAssets() } : {},
);
