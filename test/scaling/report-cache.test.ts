import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveInto, PREBUILT_ENV } from '../../test-support/scaling/generator.js';
import { setup } from '../../test-support/scaling/global-setup.js';
import {
  CACHE_OFF_ENV,
  MEASURED_ENV,
  REPORT_CACHE_SOURCES,
  reportCacheDir,
  reportCacheKey,
} from '../../test-support/scaling/report-cache.js';

const ROOT = resolve(import.meta.dirname, '../..');
const norm = (p: string): string => p.split('\\').join('/');

/** Every repo file reachable from `entry` through relative static imports and `import('…')` (`.js` names `.ts`/`.tsx`). */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const todo = [entry];
  const re = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g;
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const m of text.matchAll(re)) {
      const spec = (m[1] as string).replace(/\.js$/, '');
      const base = norm(relative(ROOT, resolve(ROOT, dirname(file), spec)));
      const found = ['.ts', '.tsx', '/index.ts'].map((x) => base + x).find((f) => existsSync(join(ROOT, f)));
      if (found === undefined) {
        // a non-code import (json, a type-only d.ts): it must still be covered when it is a file
        if (existsSync(join(ROOT, base))) todo.push(base);
        continue;
      }
      todo.push(found);
    }
  }
  return [...seen].sort();
}

const matchesGlobs = (f: string): boolean => REPORT_CACHE_SOURCES.some((g) => matchesGlob(f, g));

describe('the scaling report cache', () => {
  const dirs: string[] = [];
  // setup() writes process.env directly: put back what the run's own global setup gave this worker
  const saved = { reports: process.env[PREBUILT_ENV], measured: process.env[MEASURED_ENV] };
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  afterEach(async () => {
    restore(PREBUILT_ENV, saved.reports);
    restore(MEASURED_ENV, saved.measured);
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const tmp = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'otel-report-cache-'));
    dirs.push(d);
    return d;
  };

  it('the cache key covers every file the generator imports', () => {
    const reached = importClosure('test-support/scaling/generator.ts');
    expect(reached.length).toBeGreaterThan(10);
    expect(reached.filter((f) => !matchesGlobs(f))).toEqual([]);
  });

  it('the key changes when a covered file changes and not when another does', async () => {
    const root = await tmp();
    await mkdir(join(root, 'src/writer'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lock');
    await writeFile(join(root, 'src/writer/a.ts'), 'one');
    await writeFile(join(root, 'docs/a.md'), 'one');
    const before = reportCacheKey(root);
    expect(before).toMatch(/^[0-9a-f]{16}$/);
    expect(reportCacheKey(root)).toBe(before);
    await writeFile(join(root, 'docs/a.md'), 'two');
    expect(reportCacheKey(root)).toBe(before);
    await writeFile(join(root, 'src/writer/a.ts'), 'two');
    const after = reportCacheKey(root);
    expect(after).not.toBe(before);
    await writeFile(join(root, 'src/writer/b.ts'), 'new');
    expect(reportCacheKey(root)).not.toBe(after);
    expect(reportCacheDir(root)).toBe(join(root, '.cache', 'scaling-reports', reportCacheKey(root)));
  });

  it('keeps measurements per run and reports across runs', async () => {
    vi.stubEnv('OTEL_HTML_SCALING', '1');
    vi.stubEnv(CACHE_OFF_ENV, '');
    const teardown = await setup();
    const reports = process.env[PREBUILT_ENV] as string;
    const measured = process.env[MEASURED_ENV] as string;
    expect(reports).toBe(reportCacheDir());
    expect(measured).not.toBe(reports);
    expect(existsSync(reports)).toBe(true);
    await teardown();
    expect(existsSync(measured)).toBe(false);
    expect(existsSync(reports)).toBe(true);
  });

  it('without OTEL_HTML_SCALING the reports are cached and no measurement folder is made', async () => {
    vi.stubEnv('OTEL_HTML_SCALING', '');
    vi.stubEnv(CACHE_OFF_ENV, '');
    delete process.env[MEASURED_ENV];
    const teardown = await setup();
    expect(process.env[PREBUILT_ENV]).toBe(reportCacheDir());
    expect(process.env[MEASURED_ENV]).toBeUndefined();
    await teardown();
    expect(existsSync(reportCacheDir())).toBe(true);
  });

  it('OTEL_HTML_SCALING_CACHE=off keeps the reports in a temp folder removed at the end', async () => {
    vi.stubEnv('OTEL_HTML_SCALING', '1');
    vi.stubEnv(CACHE_OFF_ENV, 'off');
    const teardown = await setup();
    const reports = process.env[PREBUILT_ENV] as string;
    expect(reports).not.toBe(reportCacheDir());
    expect(reports.startsWith(tmpdir())).toBe(true);
    expect(existsSync(reports)).toBe(true);
    await teardown();
    expect(existsSync(reports)).toBe(false);
  });

  it('leaves no folder of a dead builder behind: its lock and half-copied report are swept', async () => {
    const { sweepStale } = await import('../../test-support/scaling/report-cache.js');
    const dir = await tmp();
    await mkdir(join(dir, 'x.lock'), { recursive: true });
    await writeFile(join(dir, 'x.lock', 'holder'), '2147483646:0'); // no such process
    await mkdir(join(dir, 'live.lock'), { recursive: true });
    await writeFile(join(dir, 'live.lock', 'holder'), `${process.pid}:0`);
    await mkdir(join(dir, 'y.part-2147483646-0'), { recursive: true });
    await mkdir(join(dir, 'done'), { recursive: true });
    await sweepStale(dir);
    expect((await readdir(dir)).sort()).toEqual(['done', 'live.lock']);
  });

  it('a report moved into the cache appears whole at its name, from another filesystem too', async () => {
    const from = await tmp();
    await mkdir(join(from, 'data'));
    await writeFile(join(from, 'data', 'manifest.js'), 'm');
    await writeFile(join(from, 'meta.json'), '{}');
    // the cache lives under the repo, the source in the temp directory: another filesystem on most machines
    const cacheRoot = join(ROOT, '.cache', 'scaling-reports-test');
    dirs.push(cacheRoot);
    await mkdir(cacheRoot, { recursive: true });
    const target = join(cacheRoot, `shape-${process.pid}`);
    await moveInto(from, target);
    expect((await readdir(cacheRoot)).filter((n) => n.includes('.part-'))).toEqual([]);
    expect(readFileSync(join(target, 'data', 'manifest.js'), 'utf8')).toBe('m');
    expect(existsSync(from)).toBe(false);
  });
});
