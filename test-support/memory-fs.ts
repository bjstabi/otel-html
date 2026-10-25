import type { FileSystem } from '../src/writer/ports.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function notFound(p: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
}

export function createMemoryFileSystem(): FileSystem & {
  snapshot(): Map<string, string>;
  failNextWrite(pathSuffix: string): void;
} {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const failures: string[] = [];

  const checkFail = (p: string): void => {
    const i = failures.findIndex((s) => p.endsWith(s));
    if (i >= 0) {
      failures.splice(i, 1);
      throw new Error(`injected write failure: ${p}`);
    }
  };

  return {
    async readText(p) {
      const b = files.get(p);
      if (b === undefined) throw notFound(p);
      return dec.decode(b);
    },
    async writeTextAtomic(p, text) {
      checkFail(p);
      files.set(p, enc.encode(text));
    },
    async writeBytes(p, bytes) {
      checkFail(p);
      files.set(p, bytes.slice());
    },
    async mkdirp(p) {
      dirs.add(p);
    },
    async exists(p) {
      return files.has(p) || dirs.has(p);
    },
    async list(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of [...files.keys(), ...dirs]) {
        if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0] ?? '');
      }
      names.delete('');
      return [...names].sort();
    },
    async remove(p) {
      files.delete(p);
      dirs.delete(p);
    },
    async createExclusive(p, text) {
      if (files.has(p)) return false;
      checkFail(p);
      files.set(p, enc.encode(text));
      return true;
    },
    snapshot() {
      return new Map([...files].map(([k, v]) => [k, dec.decode(v)]));
    },
    failNextWrite(pathSuffix) {
      failures.push(pathSuffix);
    },
  };
}
