import { Command, CommanderError } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { OtelHtmlError } from '../model/errors.js';
import type { WriterDeps } from '../writer/session.js';
import { addCiCommand } from './commands/ci.js';
import { addConfigCommand } from './commands/config-print.js';
import { addConvertCommand } from './commands/convert.js';
import { addMergeCommand } from './commands/merge.js';
import { addRunCommand } from './commands/run.js';
import { addServeCommand } from './commands/serve.js';
import type { CliIo } from './io.js';

export type { CliIo };

/** The writer's deps as the CLI's composition root supplies them: all optional, `resolveDeps` fills the rest. */
export type CliDeps = Partial<WriterDeps>;

/** Thrown by a command's action to end the run with this exit code and no further message. */
export class CliExit extends Error {
  readonly exitCode: number;
  constructor(exitCode: number) {
    super(`exit ${exitCode}`);
    this.exitCode = exitCode;
  }
}

/** Commander parse failures never exit the process: they throw, and `runCli` maps them. */
export function buildProgram(io: CliIo, deps: CliDeps): Command {
  const program = new Command('otel-html')
    .description('turn OpenTelemetry data into a self-contained HTML report')
    .version(pkg.version)
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  addConvertCommand(program, io, deps);
  addMergeCommand(program, io, deps);
  addServeCommand(program, io, deps);
  addRunCommand(program, io, deps);
  addConfigCommand(program, io, deps.fs);
  addCiCommand(program, io, deps);
  return program;
}

function exitCodeOf(e: OtelHtmlError): 1 | 2 {
  return e.code === 'usage' || e.code.startsWith('invalid-') ? 2 : 1;
}

/** Parse and run `argv` (without node and script), returning the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<number> {
  try {
    await buildProgram(io, deps).parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    if (e instanceof CliExit) return e.exitCode;
    if (e instanceof CommanderError) {
      // Commander has already printed its message; help and version are successes.
      return e.exitCode === 0 ? 0 : 2;
    }
    const { OTEL_HTML_DEBUG: debugFlag } = io.env;
    const debug = debugFlag === '1';
    const text = e instanceof Error ? (debug && e.stack !== undefined ? e.stack : e.message) : String(e);
    io.stderr(`error: ${text}\n`);
    return e instanceof OtelHtmlError ? exitCodeOf(e) : 1;
  }
}
