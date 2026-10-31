import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  const code = async (p: Promise<unknown>): Promise<unknown> => {
    try {
      await p;
    } catch (e) {
      return e instanceof Error && 'code' in e ? e.code : e;
    }
    return 'resolved';
  };

  test('a write in pieces round-trips atomically, like writeTextAtomic', async () => {
    const f = fs();
    await f.mkdirp(join(dir, 'a'));
    if (_name === 'node') expect(f.writePiecesAtomic).toBeDefined(); // memory: the fallback
    const write =
      f.writePiecesAtomic ?? ((p: string, xs: Iterable<string>) => f.writeTextAtomic(p, [...xs].join('')));
    await write(join(dir, 'a/x.js'), ['he', '', 'llo \u2028', 'é']);
    expect(await f.readText(join(dir, 'a/x.js'))).toBe('hello \u2028é');
    expect(await f.list(join(dir, 'a'))).toEqual(['x.js']);
  });

  test('many small pieces and pieces larger than a write batch join exactly', async () => {
    const f = fs();
    const write =
      f.writePiecesAtomic ?? ((p: string, xs: Iterable<string>) => f.writeTextAtomic(p, [...xs].join('')));
    const pieces = [
      ...Array.from({ length: 50_000 }, (_, i) => `{"id":${i},"s":"é\u2028"},`),
      'x'.repeat(600_000),
      '',
      '末',
    ];
    await f.mkdirp(join(dir, 'b'));
    await write(join(dir, 'b/big.js'), pieces);
    expect(await f.readText(join(dir, 'b/big.js'))).toBe(pieces.join(''));
  });

  test('atomic write round-trips and leaves no tmp file', async () => {
    const f = fs();
    await f.mkdirp(join(dir, 'a/b'));
    await f.writeTextAtomic(join(dir, 'a/b/x.txt'), 'hello');
    await f.writeTextAtomic(join(dir, 'a/b/x.txt'), 'again');
    expect(await f.readText(join(dir, 'a/b/x.txt'))).toBe('again');
    expect(await f.list(join(dir, 'a/b'))).toEqual(['x.txt']);
  });

  test('readChunks yields the file in pieces that join to its bytes; a missing file fails with ENOENT', async () => {
    const f = fs();
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    await f.writeBytes(join(dir, 'big.bin'), bytes);
    const read = async (p: string): Promise<Uint8Array[]> => {
      const out: Uint8Array[] = [];
      for await (const piece of f.readChunks?.(p) ?? []) out.push(piece);
      return out;
    };
    const pieces = await read(join(dir, 'big.bin'));
    expect(pieces.length).toBeGreaterThan(1);
    expect(Buffer.concat(pieces).equals(bytes)).toBe(true);
    expect(await code(read(join(dir, 'nope.bin')))).toBe('ENOENT');
  });

  test('list of a missing directory fails with ENOENT', async () => {
    const f = fs();
    await f.mkdirp(dir);
    expect(await code(f.list(join(dir, 'nope')))).toBe('ENOENT');
  });

  test('writeTextAtomic and createExclusive need an existing parent; writeBytes creates parents', async () => {
    const f = fs();
    await f.mkdirp(dir);
    expect(await code(f.writeTextAtomic(join(dir, 'no/such/x'), 'v'))).toBe('ENOENT');
    expect(await code(f.createExclusive(join(dir, 'no/such/y'), 'v'))).toBe('ENOENT');
    await f.writeBytes(join(dir, 'made/deep/z'), new Uint8Array([1]));
    expect(await f.list(join(dir, 'made/deep'))).toEqual(['z']);
    await f.writeTextAtomic(join(dir, 'made/ok'), 'v');
  });

  test('directories exist implicitly for the prefixes of written files', async () => {
    const f = fs();
    await f.mkdirp(dir);
    await f.writeBytes(join(dir, 'a/b/c'), new Uint8Array([1]));
    expect(await f.exists(join(dir, 'a'))).toBe(true);
    expect(await f.exists(join(dir, 'a/b'))).toBe(true);
    expect(await f.exists(join(dir, 'a/b/c'))).toBe(true);
    expect(await f.exists(join(dir, 'a/b/d'))).toBe(false);
    expect(await f.exists(join(dir, 'a/bb'))).toBe(false);
    expect(await f.list(join(dir, 'a'))).toEqual(['b']);
  });

  test('realpath of an existing path is a path that still exists', async () => {
    const f = fs();
    await f.mkdirp(join(dir, 'rp'));
    expect(await f.exists(await f.realpath(join(dir, 'rp')))).toBe(true);
  });

  test('mkdirp creates ancestors and is idempotent', async () => {
    const f = fs();
    await f.mkdirp(join(dir, 'p/q/r'));
    await f.mkdirp(join(dir, 'p/q/r'));
    expect(await f.exists(join(dir, 'p/q'))).toBe(true);
    expect(await f.list(join(dir, 'p'))).toEqual(['q']);
  });

  test('remove of a missing path is a no-op', async () => {
    const f = fs();
    await f.mkdirp(dir);
    await f.remove(join(dir, 'missing'));
  });

  test('createExclusive returns false the second time', async () => {
    const f = fs();
    await f.mkdirp(dir);
    expect(await f.createExclusive(join(dir, 'lock'), 'one')).toBe(true);
    expect(await f.createExclusive(join(dir, 'lock'), 'two')).toBe(false);
    expect(await f.readText(join(dir, 'lock'))).toBe('one');
  });

  test('readBytes returns the exact bytes and fails with ENOENT when missing', async () => {
    const f = fs();
    await f.mkdirp(dir);
    await f.writeBytes(join(dir, 'bin'), new Uint8Array([0, 255, 1]));
    expect([...(await f.readBytes(join(dir, 'bin')))]).toEqual([0, 255, 1]);
    expect(await code(f.readBytes(join(dir, 'missing')))).toBe('ENOENT');
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

// A report from elsewhere may hold symlinks; a write replaces the link and never writes through it. Creating symlinks
// on Windows needs a privilege the runners may lack.
describe.skipIf(process.platform === 'win32')('node writes never follow a symlink', () => {
  const outside = (): string => join(dir, 'outside');
  beforeEach(async () => {
    await writeFile(outside(), 'precious');
  });

  test('writeBytes replaces a symlink at the destination', async () => {
    await symlink(outside(), join(dir, 'x'));
    await createNodeFileSystem().writeBytes(join(dir, 'x'), new TextEncoder().encode('new'));
    expect(await readFile(outside(), 'utf8')).toBe('precious');
    expect((await lstat(join(dir, 'x'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(dir, 'x'), 'utf8')).toBe('new');
  });

  test('writeBytes replaces a dangling symlink instead of creating its target', async () => {
    await symlink(join(dir, 'missing'), join(dir, 'x'));
    await createNodeFileSystem().writeBytes(join(dir, 'x'), new TextEncoder().encode('new'));
    expect(await readdir(dir)).not.toContain('missing');
    expect(await readFile(join(dir, 'x'), 'utf8')).toBe('new');
  });

  test.each(['writeTextAtomic', 'writePiecesAtomic'] as const)(
    '%s ignores a symlink at its tmp path',
    async (m) => {
      const fs = createNodeFileSystem();
      await symlink(outside(), join(dir, `x.tmp-${process.pid}`));
      if (m === 'writeTextAtomic') await fs.writeTextAtomic(join(dir, 'x'), 'new');
      else await fs.writePiecesAtomic?.(join(dir, 'x'), ['n', 'ew']);
      expect(await readFile(outside(), 'utf8')).toBe('precious');
      expect(await readFile(join(dir, 'x'), 'utf8')).toBe('new');
    },
  );
});

test('memory fs failNextWrite fails once and snapshot reflects content', async () => {
  const f = createMemoryFileSystem();
  await f.mkdirp('/o');
  f.failNextWrite('report.json');
  await expect(f.writeTextAtomic('/o/report.json', 'x')).rejects.toThrow();
  await f.writeTextAtomic('/o/report.json', 'y');
  expect(f.snapshot().get('/o/report.json')).toBe('y');
});

// The contract tests build paths with node:path, which uses backslashes on Windows.
test('memory fs treats backslash as a separator, like node on Windows', async () => {
  const f = createMemoryFileSystem();
  await f.mkdirp('C:\\r\\a');
  await f.writeTextAtomic('C:\\r\\a\\x.txt', 'v');
  expect(await f.list('C:\\r\\a')).toEqual(['x.txt']);
  expect(await f.exists('C:/r/a/x.txt')).toBe(true);
  expect(await f.readText('C:/r/a\\x.txt')).toBe('v');
});

test('fixed clock advances', () => {
  const c = createFixedClock(parseUnixNanos(10n, 'p'));
  c.advance(5n);
  expect(c.nowUnixNano()).toBe(15n);
  expect(typeof c.monotonicMs()).toBe('number');
});
