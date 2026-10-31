import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

/**
 * otel-html-setup's install.sh against a fake `gh` that serves a release, on a PATH that has only the tools the script
 * needs and one checksum tool: GNU-style `sha256sum`, or `shasum` alone as on older macOS runners. Bash script: not
 * run on Windows.
 */
const INSTALL = resolve(__dirname, '../../.github/actions/otel-html-setup/install.sh');
const ASSET = 'otel-html-linux-x64';
const TOOLS = ['bash', 'grep', 'mkdir', 'rm', 'mv', 'chmod', 'cp', 'perl'];

const which = (tool: string): string | undefined => {
  const r = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  const p = r.stdout.trim();
  return r.status === 0 && p.startsWith('/') ? p : undefined;
};

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(process.platform === 'win32')('otel-html-setup install.sh', { timeout: 30_000 }, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'install-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A release folder with the binary and a SHA256SUMS listing it (with `sum`) and another platform's asset. */
  const release = (sum = sha256('binary')): void => {
    const rel = join(dir, 'release');
    mkdirSync(rel);
    writeFileSync(join(rel, ASSET), 'binary');
    writeFileSync(join(rel, 'SHA256SUMS'), `${'0'.repeat(64)}  otel-html-darwin-arm64\n${sum}  ${ASSET}\n`);
  };

  /** Runs install.sh on a PATH of TOOLS plus `checker`, with `gh release download` copying the release folder. */
  const install = (checker: string): { status: number | null; stderr: string } => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const tool of [...TOOLS, checker]) {
      const p = which(tool);
      if (p !== undefined) symlinkSync(p, join(bin, tool));
    }
    // gh release download <tag> -R <repo> -D <dir> -p <pattern>...
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/bash\nset -eu\nwhile [ "$1" != -D ]; do shift; done\ncp "${join(dir, 'release')}"/* "$2"/\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const r = spawnSync('bash', [INSTALL, '0.2.0'], {
      encoding: 'utf8',
      env: {
        PATH: bin,
        REPO: 'o/r',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
        RUNNER_TEMP: join(dir, 'temp'),
        GITHUB_PATH: join(dir, 'github-path'),
      },
    });
    return { status: r.status, stderr: r.stderr };
  };
  const installed = (): string => join(dir, 'temp/otel-html/bin/otel-html');

  for (const checker of ['sha256sum', 'shasum']) {
    describe.skipIf(which(checker) === undefined)(`with only ${checker}`, () => {
      test('installs a binary whose checksum matches', () => {
        release();
        const r = install(checker);
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
        expect(readFileSync(installed(), 'utf8')).toBe('binary');
        expect(readFileSync(join(dir, 'github-path'), 'utf8')).toBe(`${join(dir, 'temp/otel-html/bin')}\n`);
      });

      test('refuses a binary whose checksum does not match', () => {
        release(sha256('other'));
        expect(install(checker).status).not.toBe(0);
        expect(existsSync(installed())).toBe(false);
      });
    });
  }

  test('refuses a release whose SHA256SUMS has no line for the binary', () => {
    release();
    writeFileSync(join(dir, 'release/SHA256SUMS'), `${'0'.repeat(64)}  otel-html-darwin-arm64\n`);
    const r = install('shasum');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`no checksum for ${ASSET} in SHA256SUMS`);
    expect(existsSync(installed())).toBe(false);
  });
});
