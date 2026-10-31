import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { SiteIndex } from '../../../src/cli/ci/site.js';
import { copyReport, readSiteIndex, removePaths, writeSite } from '../../../src/cli/ci/site-io.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'site-io-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('site-io', () => {
  test('writeSite then readSiteIndex round-trips and writes the landing page and .nojekyll', async () => {
    const index: SiteIndex = {
      version: 1,
      channels: {
        ci: {
          kind: 'workflow',
          title: 'ci',
          headBranch: 'main',
          runs: [
            {
              runId: 1,
              attempt: 1,
              conclusion: 'success',
              headSha: 'a',
              headBranch: 'main',
              completedAt: '2026-01-01T00:00:00Z',
              runUrl: 'https://x/1',
              reportPath: 'ci/runs/1',
            },
          ],
        },
      },
    };
    await writeSite(dir, index, 'o/r');
    expect(await readSiteIndex(dir)).toEqual(index);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('o/r');
    expect(existsSync(join(dir, '.nojekyll'))).toBe(true);
  });

  test('readSiteIndex of an empty folder is an empty index', async () => {
    expect(await readSiteIndex(dir)).toEqual({ version: 1, channels: {} });
  });

  test('removePaths rejects a path outside the folder and removes nothing', async () => {
    mkdirSync(join(dir, 'site', 'a'), { recursive: true });
    await expect(removePaths(join(dir, 'site'), ['a', '../x'])).rejects.toThrow('not inside');
    expect(existsSync(join(dir, 'site', 'a'))).toBe(true);
    await expect(removePaths(join(dir, 'site'), [join(dir, 'site', 'a')])).rejects.toThrow('not inside');
    await expect(removePaths(join(dir, 'site'), ['.'])).rejects.toThrow('not inside');
  });

  test('removePaths accepts a child whose name starts with two dots', async () => {
    mkdirSync(join(dir, '..foo'), { recursive: true });
    await removePaths(dir, ['..foo']);
    expect(existsSync(join(dir, '..foo'))).toBe(false);
  });

  test('removePaths removes folders and ignores missing ones', async () => {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    await removePaths(dir, ['a/b', 'missing']);
    expect(existsSync(join(dir, 'a'))).toBe(true);
    expect(existsSync(join(dir, 'a', 'b'))).toBe(false);
  });

  test('copyReport replaces an existing target', async () => {
    const from = join(dir, 'from');
    const to = join(dir, 'to', 'deep');
    mkdirSync(from);
    writeFileSync(join(from, 'new.txt'), 'n');
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, 'old.txt'), 'o');
    await copyReport(from, to);
    expect(existsSync(join(to, 'new.txt'))).toBe(true);
    expect(existsSync(join(to, 'old.txt'))).toBe(false);
  });
});
