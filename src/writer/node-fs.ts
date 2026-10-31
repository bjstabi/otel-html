import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileSystem } from './ports.js';

/** Characters `writePiecesAtomic` gathers before writing them. */
const PIECE_BATCH = 256 * 1024;

/**
 * Creates `p` afresh: whatever is there, a symlink included, is removed first and the file is opened exclusively, so
 * a write never goes through a link planted in a report from elsewhere.
 */
async function writeFresh(p: string, data: string | Uint8Array): Promise<void> {
  await rm(p, { force: true });
  await writeFile(p, data, { flag: 'wx' });
}

export function createNodeFileSystem(): FileSystem {
  return {
    readText: (p) => readFile(p, 'utf8'),
    async readBytes(p) {
      return new Uint8Array(await readFile(p));
    },
    readChunks: (p) => createReadStream(p), // 64 KiB pieces
    async writeTextAtomic(p, text) {
      const tmp = `${p}.tmp-${process.pid}`;
      try {
        await writeFresh(tmp, text);
        await rename(tmp, p);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
    async writePiecesAtomic(p, pieces) {
      const tmp = `${p}.tmp-${process.pid}`;
      try {
        await rm(tmp, { force: true });
        const handle = await open(tmp, 'wx');
        try {
          // Pieces are often small (one series each): written in batches of about PIECE_BATCH characters, not one
          // write call per piece.
          let batch = '';
          for (const piece of pieces) {
            batch += piece;
            if (batch.length >= PIECE_BATCH) {
              await handle.write(batch, null, 'utf8');
              batch = '';
            }
          }
          if (batch.length > 0) await handle.write(batch, null, 'utf8');
        } finally {
          await handle.close();
        }
        await rename(tmp, p);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
    async writeBytes(p, bytes) {
      await mkdir(dirname(p), { recursive: true });
      await writeFresh(p, bytes);
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
