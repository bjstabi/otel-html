import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// A write that stores only half of what it was given, as a full pipe or a signal can make a real one do.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      const write = handle.write.bind(handle) as (...a: unknown[]) => Promise<{ bytesWritten: number }>;
      return new Proxy(handle, {
        get(target, prop) {
          if (prop !== 'write') {
            const v = Reflect.get(target, prop) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          }
          return async (data: unknown, a?: unknown, b?: unknown) => {
            if (typeof data === 'string') return write(data, a, b);
            const buf = data as Uint8Array;
            const offset = typeof a === 'number' ? a : 0;
            const length = typeof b === 'number' ? b : buf.length - offset;
            return write(buf, offset, Math.max(1, Math.floor(length / 2)));
          };
        },
      });
    },
  };
});

const { createNodeFileSystem } = await import('../../src/writer/node-fs.js');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otel-html-short-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('atomic writes against short writes', () => {
  test('writeByteChunksAtomic writes every byte of every chunk', async () => {
    const chunks = [new Uint8Array(1000).fill(1), new Uint8Array(333).fill(2), new Uint8Array(7).fill(3)];
    async function* source(): AsyncGenerator<Uint8Array> {
      yield* chunks;
    }
    const p = join(dir, 'x.bin');
    await createNodeFileSystem().writeByteChunksAtomic?.(p, source());
    expect(new Uint8Array(await readFile(p))).toEqual(new Uint8Array(Buffer.concat(chunks)));
  });

  test('writePiecesAtomic writes every piece', async () => {
    const pieces = ['a'.repeat(300_000), 'é'.repeat(10), 'tail'];
    const p = join(dir, 'x.txt');
    await createNodeFileSystem().writePiecesAtomic?.(p, pieces);
    expect(await readFile(p, 'utf8')).toBe(pieces.join(''));
  });
});
