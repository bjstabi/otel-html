#!/usr/bin/env node
import * as v8 from 'node:v8';
import { bunEmbeddedViewerAssets, hasBunEmbeddedFiles } from '../writer/viewer-assets.js';
import { runCli } from './program.js';

// The composition root of the CLI: the only place that touches process io and exits.

// Under Node, V8 sizes its heap at several times the live data when allocation is as steady as a large convert's
// (one record per point); favouring size keeps a 72M-point metrics run under 512 MB resident instead of about 800 MB,
// for a slower run. V8 reads this flag as it goes, so setting it here takes effect. The library sets no flags.
if (!('bun' in process.versions)) v8.setFlagsFromString('--optimize-for-size');

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
