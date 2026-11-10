import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  jobSourceKey,
  MAX_UPDATE_BYTES,
  nameMatches,
  parseUpdateName,
  readUpdate,
  type UpdateJson,
  UpdateJsonSchema,
  updateName,
} from '../../../src/cli/ci/update.js';
import { createNodeFileSystem } from '../../../src/writer/node-fs.js';

const base = { version: 1, runId: 42, runAttempt: 1, createdAt: '2026-11-10T00:00:00Z' } as const;
const file = (path: string, bytes: number) => ({
  path,
  bytes,
  rows: 1,
  timeMin: '1',
  timeMax: '2',
  values: {},
});
const push = (over: Partial<UpdateJson> = {}): UpdateJson => ({
  ...base,
  kind: 'push',
  jobId: 7,
  jobName: 'build',
  sequence: 3,
  partitions: [
    { source: 'job:7#flush:1', files: { spans: file('partitions/0/spans.parquet', 4) }, carried: true },
  ],
  ...over,
});

const ciPart = (source: string, carried: boolean) => ({
  source,
  files: { spans: file('ci/spans.parquet', 4) },
  carried,
});

describe('names', () => {
  test('updateName per kind', () => {
    expect(updateName(push())).toBe('otel-html-update-push-7-3');
    expect(updateName({ ...base, kind: 'run' })).toBe('otel-html-update-run-42-1');
    expect(updateName({ ...base, kind: 'remove-pr', pr: 5 })).toBe('otel-html-update-remove-pr-5-42');
    expect(updateName({ ...base, kind: 'reopen-pr', pr: 5 })).toBe('otel-html-update-reopen-pr-5-42');
  });
  test('a string job id is hashed, stably, per attempt', () => {
    const u = push({ jobId: 'name:build@r1' });
    expect(updateName(u)).toMatch(/^otel-html-update-push-h[0-9a-f]{12}-3$/);
    expect(jobSourceKey('name:build@r1', 1)).toBe(jobSourceKey('name:build@r1', 1));
    expect(jobSourceKey('name:build@r1', 1)).not.toBe(jobSourceKey('name:build@r1', 2));
  });
  test('parseUpdateName', () => {
    expect(parseUpdateName('otel-html-update-remove-pr-5-42')).toEqual({
      kind: 'remove-pr',
      pr: 5,
      runId: 42,
    });
    expect(parseUpdateName('otel-html-update-reopen-pr-5-42')).toEqual({
      kind: 'reopen-pr',
      pr: 5,
      runId: 42,
    });
    expect(parseUpdateName('otel-html-update-run-42-2')).toEqual({ kind: 'run', runId: 42, runAttempt: 2 });
    expect(parseUpdateName('otel-html-update-push-h0123456789ab-3')).toEqual({
      kind: 'push',
      jobKey: 'h0123456789ab',
      sequence: 3,
    });
    expect(parseUpdateName('ci-run-report')).toBeUndefined();
    expect(parseUpdateName('otel-html-update-push-7-x')).toBeUndefined();
    expect(parseUpdateName('otel-html-update-push-7-3-9')).toBeUndefined();
  });
  test('nameMatches', () => {
    const u = push();
    const p = parseUpdateName(updateName(u));
    expect(p && nameMatches(p, u)).toBe(true);
    expect(p && nameMatches(p, push({ sequence: 4 }))).toBe(false);
    expect(p && nameMatches(p, push({ jobId: 8 }))).toBe(false);
    const r = parseUpdateName('otel-html-update-run-42-1');
    expect(r && nameMatches(r, { ...base, kind: 'run' })).toBe(true);
    expect(r && nameMatches(r, { ...base, runId: 43, kind: 'run' })).toBe(false);
    expect(r && nameMatches(r, { ...base, runAttempt: 2, kind: 'run' })).toBe(false);
    const d = parseUpdateName('otel-html-update-remove-pr-5-42');
    expect(d && nameMatches(d, { ...base, kind: 'remove-pr', pr: 5 })).toBe(true);
    expect(d && nameMatches(d, { ...base, kind: 'reopen-pr', pr: 5 })).toBe(false);
    expect(d && nameMatches(d, { ...base, kind: 'remove-pr', pr: 6 })).toBe(false);
  });
});

describe('UpdateJsonSchema', () => {
  const ok = (v: unknown) => UpdateJsonSchema.safeParse(v).success;
  test('accepts each kind', () => {
    expect(ok(push())).toBe(true);
    expect(ok({ ...base, kind: 'run' })).toBe(true);
    expect(ok({ ...base, kind: 'remove-pr', pr: 5 })).toBe(true);
  });
  test('rejects', () => {
    expect(ok({ ...push(), extra: 1 })).toBe(false);
    const { sequence: _s, ...noSeq } = push();
    expect(ok(noSeq)).toBe(false);
    expect(ok({ ...base, kind: 'remove-pr' })).toBe(false);
    expect(ok({ ...base, runId: '42', kind: 'run' })).toBe(false);
    expect(ok({ ...base, kind: 'run', pr: 5 })).toBe(false);
    expect(ok({ ...base, kind: 'remove-pr', pr: 5, ci: push().partitions?.[0] })).toBe(false);
    expect(ok(push({ partitions: [{ source: 'job:7#bad source', files: {}, carried: false }] }))).toBe(false);
  });
});

describe('stricter fields', () => {
  const ok = (v: unknown) => UpdateJsonSchema.safeParse(v).success;
  test('attempt and sequence are at least 1, createdAt is an ISO date-time, ci is carried', () => {
    expect(ok({ ...base, runAttempt: 0, kind: 'run' })).toBe(false);
    expect(ok(push({ sequence: 0 }))).toBe(false);
    expect(ok({ ...base, createdAt: 'yesterday', kind: 'run' })).toBe(false);
    expect(ok(push({ ci: ciPart('ci:7', false) }))).toBe(false);
    expect(ok(push({ ci: ciPart('ci:7', true) }))).toBe(true);
  });
  test('names reject leading zeros', () => {
    expect(parseUpdateName('otel-html-update-push-07-3')).toBeUndefined();
    expect(parseUpdateName('otel-html-update-push-7-03')).toBeUndefined();
    expect(parseUpdateName('otel-html-update-run-042-1')).toBeUndefined();
    expect(parseUpdateName('otel-html-update-remove-pr-5-042')).toBeUndefined();
  });
});

describe('readUpdate', () => {
  const fs = createNodeFileSystem();
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'update-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const put = (rel: string, content: string | number = 'data') => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content === 'data' ? 'abcd' : String(content));
  };
  const writeJson = (u: unknown) => put('update.json', JSON.stringify(u));
  const valid = () => {
    writeJson(push());
    put('partitions/0/spans.parquet');
  };

  test('accepts a valid push folder', async () => {
    valid();
    expect((await readUpdate(fs, dir)).kind).toBe('push');
  });
  test('accepts a run folder and a remove-pr folder', async () => {
    writeJson({ ...base, kind: 'run' });
    put('report/index.html');
    put('report/.nojekyll');
    put('report/data/manifest.js');
    put('report/data/partitions/000000/spans.parquet');
    expect((await readUpdate(fs, dir)).kind).toBe('run');
  });
  test('rejects a run folder with report/assets', async () => {
    writeJson({ ...base, kind: 'run' });
    put('report/assets/app.js');
    await expect(readUpdate(fs, dir)).rejects.toThrow(/report\/assets\/app\.js/);
  });
  test('rejects a path outside the layout', async () => {
    valid();
    put('data/partitions/000000/spans.parquet');
    await expect(readUpdate(fs, dir)).rejects.toThrow(/data\/partitions/);
  });
  test('rejects an extra file', async () => {
    valid();
    put('notes.txt');
    await expect(readUpdate(fs, dir)).rejects.toThrow(/notes\.txt/);
  });
  test('rejects a manifest path that is not the update path', async () => {
    writeJson(
      push({
        partitions: [{ source: 'job:7#flush:1', files: { spans: file('../x.parquet', 4) }, carried: true }],
      }),
    );
    put('partitions/0/spans.parquet');
    await expect(readUpdate(fs, dir)).rejects.toThrow(/\.\.\/x\.parquet/);
  });
  test('rejects a source of another job', async () => {
    writeJson(
      push({
        partitions: [
          { source: 'job:9#flush:0', files: { spans: file('partitions/0/spans.parquet', 4) }, carried: true },
        ],
      }),
    );
    put('partitions/0/spans.parquet');
    await expect(readUpdate(fs, dir)).rejects.toThrow(/job:9#flush:0/);
  });
  test('rejects a ci source of another job', async () => {
    writeJson(push({ ci: ciPart('ci:9', true) }));
    put('partitions/0/spans.parquet');
    put('ci/spans.parquet');
    await expect(readUpdate(fs, dir)).rejects.toThrow(/ci:9/);
  });
  test('rejects a remove-pr folder with an extra file', async () => {
    writeJson({ ...base, kind: 'remove-pr', pr: 5 });
    put('extra.txt');
    await expect(readUpdate(fs, dir)).rejects.toThrow(/extra\.txt/);
  });
  test('rejects a symlink', async (ctx) => {
    valid();
    put('real.txt');
    try {
      symlinkSync(join(dir, 'real.txt'), join(dir, 'partitions/0/logs.parquet'));
    } catch {
      ctx.skip();
    }
    expect(existsSync(join(dir, 'partitions/0/logs.parquet'))).toBe(true);
    await expect(readUpdate(fs, dir)).rejects.toThrow(/logs\.parquet/);
  });
  test('rejects a missing carried file', async () => {
    writeJson(push());
    await expect(readUpdate(fs, dir)).rejects.toThrow(/partitions\/0\/spans\.parquet/);
  });
  test('rejects a carried file whose bytes differ', async () => {
    writeJson(push());
    put('partitions/0/spans.parquet', 'longer than four');
    await expect(readUpdate(fs, dir)).rejects.toThrow(/4 bytes/);
  });
  test('accepts a listed partition that is not carried', async () => {
    writeJson(
      push({ partitions: [{ source: 'job:7#flush:1', files: { spans: file('x', 4) }, carried: false }] }),
    );
    expect((await readUpdate(fs, dir)).kind).toBe('push');
  });
  test('rejects a total over MAX_UPDATE_BYTES', async () => {
    writeJson(push());
    put('partitions/0/spans.parquet');
    truncateSync(join(dir, 'partitions/0/spans.parquet'), MAX_UPDATE_BYTES + 1);
    await expect(readUpdate(fs, dir)).rejects.toThrow(/at most/);
  });
});
