import type { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parseEvery } from '../../../src/cli/ci/pusher-main.js';
import { runCli } from '../../../src/cli/program.js';
import { createNodeFileSystem } from '../../../src/writer/node-fs.js';
import { createTestWriter } from '../../../test-support/writer-deps.js';

let dir: string;
let calls: {
  cmd: string;
  args: readonly string[];
  opts: { detached?: boolean; env?: unknown; stdio?: unknown };
}[];
let unrefs: number;
const env = { GITHUB_RUN_ID: '1' };

const ioOf = (): Parameters<typeof runCli>[1] => ({
  stdout: () => undefined,
  stderr: () => undefined,
  env,
  cwd: dir,
  signals: { on: () => () => undefined },
  spawn: ((
    cmd: string,
    args: readonly string[],
    opts: { detached?: boolean; env?: unknown; stdio?: unknown },
  ) => {
    calls.push({ cmd, args, opts });
    return {
      unref: () => {
        unrefs++;
      },
    };
  }) as unknown as typeof spawn,
});
const deps = (): Parameters<typeof runCli>[2] => ({ ...createTestWriter().deps, fs: createNodeFileSystem() });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pusher-main-'));
  calls = [];
  unrefs = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ci pusher', () => {
  test('re-spawns itself detached with the log as stdio and returns', async () => {
    const code = await runCli(
      ['ci', 'pusher', '--report', '.otel-html/report', '--every', '60s'],
      ioOf(),
      deps(),
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    const args = ['ci', 'pusher', '--report', '.otel-html/report', '--every', '60s'];
    const tail = [...args, '--deployer-workflow', 'pages-deploy.yml', '--detached'];
    expect(c?.cmd).toBe(process.execPath);
    expect(c?.args).toEqual('bun' in process.versions ? tail : [process.argv[1], ...tail]);
    expect(c?.opts.detached).toBe(true);
    expect(c?.opts.env).toBe(env);
    const stdio = c?.opts.stdio as unknown[];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[2]).toBe(stdio[1]);
    expect(existsSync(join(dir, '.otel-html', 'publish', 'pusher.log'))).toBe(true);
    expect(unrefs).toBe(1);
  });

  test('a bad --every is a usage error', async () => {
    const code = await runCli(['ci', 'pusher', '--report', 'r', '--every', '5x'], ioOf(), deps());
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  test('durations parse', () => {
    expect(parseEvery('60s')).toBe(60_000);
    expect(parseEvery('2m')).toBe(120_000);
    expect(parseEvery('500ms')).toBe(500);
    expect(() => parseEvery('0s')).toThrow();
  });

  test('--detached with the stop file present exits 0 and removes the pid file', async () => {
    const publish = join(dir, '.otel-html', 'publish');
    mkdirSync(publish, { recursive: true });
    writeFileSync(join(publish, 'pusher.stop'), '');
    const code = await runCli(
      ['ci', 'pusher', '--report', '.otel-html/report', '--every', '500ms', '--detached'],
      ioOf(),
      deps(),
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(existsSync(join(publish, 'pusher.pid'))).toBe(false);
  });
});
