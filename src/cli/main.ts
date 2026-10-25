#!/usr/bin/env node
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
  {},
);
