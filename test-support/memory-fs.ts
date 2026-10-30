import type { FileSystem } from '../src/writer/ports.js';

const enc = new TextEncoder();
/** `readChunks` piece size: small and odd, so readers meet piece boundaries everywhere (mid-string, mid-character). */
const CHUNK_BYTES = 61;
const dec = new TextDecoder();

function fsError(code: string, desc: string, p: string): Error {
  return Object.assign(new Error(`${code}: ${desc}, '${p}'`), { code });
}

const notFound = (p: string): Error => fsError('ENOENT', 'no such file or directory', p);

/** Node on Windows accepts both separators; paths built with node:path there use backslashes. */
const norm = (p: string): string => p.replaceAll('\\', '/');

function parentOf(p: string): string | null {
  const i = p.lastIndexOf('/');
  if (i < 0) return null;
  return i === 0 ? '/' : p.slice(0, i);
}

/** Holds one write (see `holdNextWrite`) at the point where it would store its file. */
export interface WriteGate {
  /** Resolves once a write to the path is waiting at the gate. */
  reached: Promise<void>;
  /** Let the held write go through. */
  release(): void;
  /** Make the held write fail instead. */
  fail(error: Error): void;
}

/**
 * In-memory FileSystem that mirrors the node implementation where the writer relies on it:
 * writing text needs an existing parent directory (writeBytes creates parents), `list` of a missing
 * directory fails with ENOENT, directories exist implicitly for every file prefix, and `remove` refuses
 * directories. With `pieces`, `writePiecesAtomic` exists and consumes its pieces only once the write is let through
 * (the node implementation streams them), so a test can see what a held write would read late.
 */
export function createMemoryFileSystem(options: { pieces?: boolean } = {}): FileSystem & {
  snapshot(): Map<string, string>;
  failNextWrite(pathSuffix: string): void;
  holdNextWrite(pathSuffix: string): WriteGate;
} {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const failures: string[] = [];
  const gates: { suffix: string; reached(): void; open: Promise<Error | null> }[] = [];

  const checkFail = (p: string): void => {
    const i = failures.findIndex((s) => p.endsWith(s));
    if (i >= 0) {
      failures.splice(i, 1);
      throw new Error(`injected write failure: ${p}`);
    }
  };

  const passGate = async (p: string): Promise<void> => {
    const i = gates.findIndex((g) => p.endsWith(g.suffix));
    const gate = gates[i];
    if (gate === undefined) return;
    gates.splice(i, 1);
    gate.reached();
    const error = await gate.open;
    if (error !== null) throw error;
  };

  const registerDirs = (dir: string): void => {
    let cur: string | null = dir;
    while (cur !== null && cur !== '' && cur !== '/' && !dirs.has(cur)) {
      dirs.add(cur);
      cur = parentOf(cur);
    }
  };

  const isDir = (p: string): boolean => {
    if (dirs.has(p)) return true;
    const prefix = p.endsWith('/') ? p : `${p}/`;
    for (const f of files.keys()) if (f.startsWith(prefix)) return true;
    return false;
  };

  const requireParent = (p: string): void => {
    const parent = parentOf(p);
    if (parent === null || parent === '/' || isDir(parent)) return;
    throw notFound(p);
  };

  const requireWritable = (p: string): void => {
    if (isDir(p)) throw fsError('EISDIR', 'illegal operation on a directory', p);
  };

  return {
    async readText(rawP) {
      const p = norm(rawP);
      const b = files.get(p);
      if (b === undefined) {
        if (isDir(p)) throw fsError('EISDIR', 'illegal operation on a directory, read', p);
        throw notFound(p);
      }
      return dec.decode(b);
    },
    async readBytes(rawP) {
      const p = norm(rawP);
      const b = files.get(p);
      if (b === undefined) {
        if (isDir(p)) throw fsError('EISDIR', 'illegal operation on a directory, read', p);
        throw notFound(p);
      }
      return b.slice();
    },
    async *readChunks(rawP) {
      const p = norm(rawP);
      const b = files.get(p);
      if (b === undefined) {
        if (isDir(p)) throw fsError('EISDIR', 'illegal operation on a directory, read', p);
        throw notFound(p);
      }
      for (let at = 0; at < b.length; at += CHUNK_BYTES) yield b.slice(at, at + CHUNK_BYTES);
    },
    async writeTextAtomic(rawP, text) {
      const p = norm(rawP);
      requireParent(p);
      requireWritable(p);
      checkFail(p);
      await passGate(p);
      files.set(p, enc.encode(text));
    },
    ...(options.pieces === true
      ? {
          async writePiecesAtomic(rawP: string, pieces: Iterable<string>): Promise<void> {
            const p = norm(rawP);
            requireParent(p);
            requireWritable(p);
            checkFail(p);
            await passGate(p);
            files.set(p, enc.encode([...pieces].join('')));
          },
        }
      : {}),
    async writeBytes(rawP, bytes) {
      const p = norm(rawP);
      requireWritable(p);
      checkFail(p);
      const parent = parentOf(p);
      if (parent !== null) registerDirs(parent);
      files.set(p, bytes.slice());
    },
    async mkdirp(rawP) {
      const p = norm(rawP);
      if (files.has(p)) throw fsError('EEXIST', 'file already exists', p);
      registerDirs(p);
    },
    async exists(rawP) {
      const p = norm(rawP);
      return files.has(p) || isDir(p);
    },
    async list(rawDir) {
      const dir = norm(rawDir);
      if (!isDir(dir)) throw notFound(dir);
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of [...files.keys(), ...dirs]) {
        if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0] ?? '');
      }
      names.delete('');
      return [...names].sort();
    },
    async remove(rawP) {
      const p = norm(rawP);
      if (isDir(p)) throw fsError('ERR_FS_EISDIR', 'path is a directory', p);
      files.delete(p);
    },
    async realpath(rawP) {
      const p = norm(rawP);
      return p;
    },
    async createExclusive(rawP, text) {
      const p = norm(rawP);
      requireParent(p);
      if (files.has(p) || isDir(p)) return false;
      checkFail(p);
      files.set(p, enc.encode(text));
      return true;
    },
    snapshot() {
      return new Map([...files].map(([k, v]) => [k, dec.decode(v)]));
    },
    failNextWrite(pathSuffix) {
      failures.push(norm(pathSuffix));
    },
    holdNextWrite(pathSuffix) {
      let reached!: () => void;
      let decide!: (error: Error | null) => void;
      const reachedP = new Promise<void>((r) => {
        reached = r;
      });
      const open = new Promise<Error | null>((r) => {
        decide = r;
      });
      gates.push({ suffix: norm(pathSuffix), reached, open });
      return { reached: reachedP, release: () => decide(null), fail: (e) => decide(e) };
    },
  };
}
