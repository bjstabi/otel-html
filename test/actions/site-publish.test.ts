import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

/**
 * site-publish.sh: runs `ci site`, then (with PREVIEW_COMMAND) screenshots a rebuilt default-branch report. The
 * command and the preview are stubs here. Bash script: not run on Windows.
 */
const SCRIPT = resolve(__dirname, '../../.github/actions/otel-html-publish/site-publish.sh');
const { PATH } = process.env;

describe.skipIf(process.platform === 'win32')('site-publish.sh', { timeout: 30_000 }, () => {
  let dir: string;
  let out: string;
  let calls: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'site-publish-'));
    out = join(dir, 'github-output');
    calls = join(dir, 'calls');
    writeFileSync(out, '');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A command that appends `lines` to GITHUB_OUTPUT and exits with `status`. */
  const command = (lines: string[], status = 0): string[] => [
    'bash',
    '-c',
    `printf '%s\\n' "$@" >>"$GITHUB_OUTPUT"; exit ${status}`,
    '_',
    ...lines,
  ];
  const previewStub = (status: number): string => {
    const stub = join(dir, 'preview.sh');
    writeFileSync(stub, `#!/usr/bin/env bash\necho "$@" >>"${calls}"\nexit ${status}\n`, { mode: 0o755 });
    return stub;
  };
  const run = (cmd: string[], preview: string): { status: number | null; stdout: string } => {
    const r = spawnSync('bash', [SCRIPT, '/site', ...cmd], {
      env: { PATH, GITHUB_OUTPUT: out, PREVIEW_COMMAND: preview },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout };
  };

  test('screenshots a rebuilt branch report', () => {
    const r = run(command(['channel=branch/main', 'rolling=built']), previewStub(0));
    expect(r.status).toBe(0);
    expect(readFileSync(calls, 'utf8').trim()).toBe('/site branch/main');
  });
  test('skips a stub rolling report', () => {
    expect(run(command(['channel=branch/main', 'rolling=stub']), previewStub(0)).status).toBe(0);
    expect(existsSync(calls)).toBe(false);
  });
  test('skips a pull request channel', () => {
    expect(run(command(['channel=pr/3', 'rolling=built']), previewStub(0)).status).toBe(0);
    expect(existsSync(calls)).toBe(false);
  });
  test('skips without a preview command', () => {
    expect(run(command(['channel=branch/main', 'rolling=built']), '').status).toBe(0);
    expect(existsSync(calls)).toBe(false);
  });
  test('a failing preview is a warning', () => {
    const r = run(command(['channel=branch/main', 'rolling=built']), previewStub(1));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning::otel-html preview:');
  });
  test('a failing command fails the wrapper without a preview', () => {
    const r = run(command(['channel=branch/main', 'rolling=built'], 1), previewStub(0));
    expect(r.status).toBe(1);
    expect(existsSync(calls)).toBe(false);
  });
});
