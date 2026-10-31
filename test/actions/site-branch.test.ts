import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

/**
 * The gh-pages store of otel-html-publish: site-branch.sh (checkout / push under a lease) and site-lease.sh (apply,
 * push, start over on a rejected lease), against a local bare repository through the SITE_REMOTE_URL hook. Bash
 * scripts: not run on Windows, nor where git is missing.
 */
const ACTION = resolve(__dirname, '../../.github/actions/otel-html-publish');
const SITE_BRANCH = join(ACTION, 'site-branch.sh');
const SITE_LEASE = join(ACTION, 'site-lease.sh');
const { PATH } = process.env;
const hasGit = spawnSync('git', ['--version']).status === 0;

// Each git call is a process; a loaded runner can take seconds per test.
describe.skipIf(process.platform === 'win32' || !hasGit)('gh-pages site branch', { timeout: 30_000 }, () => {
  let dir: string;
  let remote: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'site-branch-'));
    remote = join(dir, 'remote.git');
    // No global or system git config (signing, hooks, default branch), and no runner credentials.
    env = {
      PATH,
      HOME: dir,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      SITE_REMOTE_URL: remote,
      SITE_LEASE_BACKOFF: '0',
      GITHUB_OUTPUT: join(dir, 'github-output'),
    };
    writeFileSync(join(dir, 'github-output'), '');
    git(['init', '-q', '--bare', '-b', 'main', remote]);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const git = (args: string[]): string => execFileSync('git', args, { env, encoding: 'utf8' }).trim();
  const run = (script: string, args: string[]): { status: number | null; stderr: string } => {
    const r = spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr };
  };
  const branch = (args: string[]): { status: number | null; stderr: string } => run(SITE_BRANCH, args);
  const tip = (): string => git(['--git-dir', remote, 'rev-parse', 'refs/heads/gh-pages']);
  const commits = (): number =>
    Number(git(['--git-dir', remote, 'rev-list', '--count', 'refs/heads/gh-pages']));
  const files = (): string[] =>
    git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'refs/heads/gh-pages']).split('\n').sort();
  const publish = (name: string, file: string): void => {
    const site = join(dir, name);
    expect(branch(['checkout', site]).status).toBe(0);
    writeFileSync(join(site, file), file);
    expect(branch(['push', site, `add ${file}`]).status).toBe(0);
  };

  test('the first publish creates the branch, a second checkout sees it, and every push is one orphan commit', () => {
    const site = join(dir, 'a');
    expect(branch(['checkout', site]).status).toBe(0);
    expect(readFileSync(join(site, '.lease'), 'utf8')).toBe('');
    writeFileSync(join(site, 'index.html'), 'one');
    expect(branch(['push', site, 'first']).status).toBe(0);
    expect(files()).toEqual(['index.html']);
    expect(commits()).toBe(1);

    const again = join(dir, 'b');
    expect(branch(['checkout', again]).status).toBe(0);
    expect(readFileSync(join(again, 'index.html'), 'utf8')).toBe('one');
    expect(readFileSync(join(again, '.lease'), 'utf8').trim()).toBe(tip());
    writeFileSync(join(again, 'two.html'), 'two');
    expect(branch(['push', again, 'second']).status).toBe(0);
    expect(files()).toEqual(['index.html', 'two.html']);
    expect(commits()).toBe(1);
  });

  test('a push over a branch that moved since the checkout is rejected with exit 1', () => {
    publish('seed', 'seed.html');
    const stale = join(dir, 'stale');
    expect(branch(['checkout', stale]).status).toBe(0);
    publish('other', 'other.html');
    const moved = tip();
    writeFileSync(join(stale, 'mine.html'), 'mine');
    const r = branch(['push', stale, 'stale']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('rejected');
    expect(tip()).toBe(moved);
    expect(files()).toEqual(['other.html', 'seed.html']);

    // a checkout lost to a branch created meanwhile is rejected too (the empty lease means "must not exist")
    rmSync(remote, { recursive: true });
    git(['init', '-q', '--bare', '-b', 'main', remote]);
    const early = join(dir, 'early');
    expect(branch(['checkout', early]).status).toBe(0);
    publish('first', 'first.html');
    writeFileSync(join(early, 'late.html'), 'late');
    expect(branch(['push', early, 'late']).status).toBe(1);
    expect(files()).toEqual(['first.html']);
  });

  test('site-lease.sh re-applies onto the new tip after a rejected lease and keeps the other change', () => {
    publish('seed', 'seed.html');
    const site = join(dir, 'site');
    const marker = join(dir, 'raced');
    // The first attempt races another publisher, which pushes between this checkout and its push.
    const command = `
      set -e
      if [ ! -e "$MARKER" ]; then
        : >"$MARKER"
        bash "$SITE_BRANCH" checkout "$OTHER"
        echo other >"$OTHER/other.html"
        bash "$SITE_BRANCH" push "$OTHER" other
      fi
      echo mine >"$1/mine.html"
      echo published=true >>"$GITHUB_OUTPUT"
    `;
    env = { ...env, MARKER: marker, SITE_BRANCH, OTHER: join(dir, 'other') };
    const r = run(SITE_LEASE, [site, 'mine', 'published=true', 'bash', '-c', command, '_', site]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('rejected');
    expect(files()).toEqual(['mine.html', 'other.html', 'seed.html']);
    expect(commits()).toBe(1);
    // only the attempt that pushed reaches the real outputs
    expect(readFileSync(join(dir, 'github-output'), 'utf8')).toBe('published=true\n');
  });

  test('site-lease.sh pushes nothing when the command did not write the push-when line', () => {
    publish('seed', 'seed.html');
    const before = tip();
    const site = join(dir, 'site');
    const command = 'echo junk >"$1/junk.html"; echo published=false >>"$GITHUB_OUTPUT"';
    const r = run(SITE_LEASE, [site, 'skip', 'published=true', 'bash', '-c', command, '_', site]);
    expect(r.status).toBe(0);
    expect(tip()).toBe(before);
    expect(files()).toEqual(['seed.html']);
    expect(readFileSync(join(dir, 'github-output'), 'utf8')).toBe('published=false\n');
  });

  test('site-lease.sh gives up with exit 1 when the command keeps failing', () => {
    const r = run(SITE_LEASE, [join(dir, 'site'), 'fail', '', 'false']);
    expect(r.status).toBe(1);
    expect(readFileSync(join(dir, 'github-output'), 'utf8')).toBe('');
  });
});
