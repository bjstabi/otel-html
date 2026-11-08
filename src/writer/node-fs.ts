import { createReadStream, openAsBlob } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileSystem } from './ports.js';

/** Characters `writePiecesAtomic` gathers before writing them. */
const PIECE_BATCH = 256 * 1024;

/** Writes all of `bytes`: a write may store fewer bytes than it was given and reports how many. */
async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  for (let off = 0; off < bytes.length; )
    off += (await handle.write(bytes, off, bytes.length - off)).bytesWritten;
}

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
          for await (const piece of pieces) {
            batch += piece;
            if (batch.length >= PIECE_BATCH) {
              await writeAll(handle, Buffer.from(batch, 'utf8'));
              batch = '';
            }
          }
          if (batch.length > 0) await writeAll(handle, Buffer.from(batch, 'utf8'));
        } finally {
          await handle.close();
        }
        await rename(tmp, p);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },
    async writeByteChunksAtomic(p, chunks) {
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}`;
      try {
        await rm(tmp, { force: true });
        const handle = await open(tmp, 'wx');
        try {
          for await (const chunk of chunks) await writeAll(handle, chunk);
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
    async entryKind(p) {
      try {
        const s = await lstat(p);
        return s.isSymbolicLink() ? 'link' : s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other';
      } catch (e) {
        if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return 'missing';
        throw e;
      }
    },
    async list(dir) {
      return (await readdir(dir)).sort();
    },
    async remove(p) {
      await rm(p, { force: true });
    },
    async removeDir(p) {
      await rm(p, { recursive: true, force: true });
    },
    openBlob: (p) => openAsBlob(p),
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
