import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parseUnixNanos } from '../../src/model/ids.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import type { FileSystem } from '../../src/writer/ports.js';
import { createFixedClock } from '../../test-support/fixed-clock.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otel-html-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.each([
  ['node', () => createNodeFileSystem()],
  ['memory', () => createMemoryFileSystem()],
] as const)('%s file system contract', (_name, make) => {
  const fs = (): FileSystem => make();

  test('atomic write round-trips and leaves no tmp file', async () => {
    const f = fs();
    await f.mkdirp(join(dir, 'a/b'));
    await f.writeTextAtomic(join(dir, 'a/b/x.txt'), 'hello');
    await f.writeTextAtomic(join(dir, 'a/b/x.txt'), 'again');
    expect(await f.readText(join(dir, 'a/b/x.txt'))).toBe('again');
    expect(await f.list(join(dir, 'a/b'))).toEqual(['x.txt']);
  });

  test('createExclusive returns false the second time', async () => {
    const f = fs();
    expect(await f.createExclusive(join(dir, 'lock'), 'one')).toBe(true);
    expect(await f.createExclusive(join(dir, 'lock'), 'two')).toBe(false);
    expect(await f.readText(join(dir, 'lock'))).toBe('one');
  });

  test('list returns sorted names; exists and remove work', async () => {
    const f = fs();
    await f.mkdirp(join(dir, 'd'));
    await f.writeTextAtomic(join(dir, 'd/b'), '1');
    await f.writeBytes(join(dir, 'd/a'), new Uint8Array([1, 2]));
    await f.writeTextAtomic(join(dir, 'd/c'), '3');
    expect(await f.list(join(dir, 'd'))).toEqual(['a', 'b', 'c']);
    expect(await f.exists(join(dir, 'd/a'))).toBe(true);
    await f.remove(join(dir, 'd/a'));
    expect(await f.exists(join(dir, 'd/a'))).toBe(false);
  });
});

test('node atomic write leaves no .tmp- file on disk', async () => {
  await createNodeFileSystem().writeTextAtomic(join(dir, 'x'), 'v');
  expect((await readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
});

test('memory fs failNextWrite fails once and snapshot reflects content', async () => {
  const f = createMemoryFileSystem();
  f.failNextWrite('report.json');
  await expect(f.writeTextAtomic('/o/report.json', 'x')).rejects.toThrow();
  await f.writeTextAtomic('/o/report.json', 'y');
  expect(f.snapshot().get('/o/report.json')).toBe('y');
});

test('fixed clock advances', () => {
  const c = createFixedClock(parseUnixNanos(10n, 'p'));
  c.advance(5n);
  expect(c.nowUnixNano()).toBe(15n);
  expect(typeof c.monotonicMs()).toBe('number');
});
