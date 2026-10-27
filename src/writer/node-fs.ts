import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileSystem } from './ports.js';

export function createNodeFileSystem(): FileSystem {
  return {
    readText: (p) => readFile(p, 'utf8'),
    async readBytes(p) {
      return new Uint8Array(await readFile(p));
    },
    async writeTextAtomic(p, text) {
      const tmp = `${p}.tmp-${process.pid}`;
      try {
        await writeFile(tmp, text, 'utf8');
        await rename(tmp, p);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
    async writeBytes(p, bytes) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
    },
    async mkdirp(p) {
      await mkdir(p, { recursive: true });
    },
    async exists(p) {
      try {
        await stat(p);
        return true;
      } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return false;
        throw e;
      }
    },
    realpath: (p) => realpath(p),
    async list(dir) {
      return (await readdir(dir)).sort();
    },
    async remove(p) {
      await rm(p, { force: true });
    },
    async createExclusive(p, text) {
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(p, 'wx');
      } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'EEXIST') return false;
        throw e;
      }
      try {
        await handle.writeFile(text, 'utf8');
      } finally {
        await handle.close();
      }
      return true;
    },
  };
}
