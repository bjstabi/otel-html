import { crc32, inflateRawSync } from 'node:zlib';
import { OtelHtmlError } from '../../model/errors.js';

const reject = (path: string, why: string): never => {
  throw new OtelHtmlError('unsupported-input', { path, message: `${path}: ${why}` });
};

const unsafeName = (name: string): boolean =>
  name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..');

/**
 * D51: the entries of a zip (central directory, zip64 fields, methods 0 and 8); rejects `..`/absolute names,
 * symlink entries (unix mode in the external attributes), a size that disagrees with the directory, and a total
 * over `maxBytes`. Directory entries are skipped.
 */
export function readZip(bytes: Uint8Array, maxBytes: number): Map<string, Uint8Array> {
  try {
    return readEntries(bytes, maxBytes);
  } catch (e) {
    // Backstop: any read the explicit checks missed is still a typed rejection.
    if (e instanceof RangeError) return reject('zip', 'truncated or malformed');
    throw e;
  }
}

function readEntries(bytes: Uint8Array, maxBytes: number): Map<string, Uint8Array> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** `len` bytes at `pos` lie inside the file (and `pos` is a safe integer). */
  const fits = (pos: number, len: number): boolean =>
    Number.isSafeInteger(pos) && pos >= 0 && pos + len <= bytes.length;
  const u64 = (at: number): number => {
    const n = v.getBigUint64(at, true);
    return n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(n);
  };
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return reject('zip', 'no end of central directory record, not a zip');
  let count = v.getUint16(end + 10, true);
  let cd = v.getUint32(end + 16, true);
  if ((count === 0xffff || cd === 0xffffffff) && end >= 20 && v.getUint32(end - 20, true) === 0x07064b50) {
    const z = u64(end - 12);
    if (!fits(z, 56) || v.getUint32(z, true) !== 0x06064b50) return reject('zip', 'bad zip64 end record');
    count = u64(z + 32);
    cd = u64(z + 48);
  }
  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (cd + 46 > bytes.length || v.getUint32(cd, true) !== 0x02014b50)
      return reject('zip', 'bad central directory');
    const flags = v.getUint16(cd + 8, true);
    const method = v.getUint16(cd + 10, true);
    let csize = v.getUint32(cd + 20, true);
    let usize = v.getUint32(cd + 24, true);
    const nameLen = v.getUint16(cd + 28, true);
    const extraLen = v.getUint16(cd + 30, true);
    const commentLen = v.getUint16(cd + 32, true);
    const attrs = v.getUint32(cd + 38, true);
    let offset = v.getUint32(cd + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cd + 46, cd + 46 + nameLen));
    // The zip64 extra holds, in order, only the fields that are 0xFFFFFFFF in the fixed header.
    if (!fits(cd, 46 + nameLen + extraLen + commentLen))
      return reject('zip', 'a central directory record runs past the end');
    let x = cd + 46 + nameLen;
    for (const xEnd = x + extraLen; x + 4 <= xEnd; x += 4 + v.getUint16(x + 2, true)) {
      if (v.getUint16(x, true) !== 1) continue;
      let f = x + 4;
      if (x + 4 + v.getUint16(x + 2, true) > xEnd) return reject(name, 'an extra field runs past its record');
      if (usize === 0xffffffff) {
        usize = u64(f);
        f += 8;
      }
      if (csize === 0xffffffff) {
        csize = u64(f);
        f += 8;
      }
      if (offset === 0xffffffff) offset = u64(f);
    }
    cd += 46 + nameLen + extraLen + commentLen;
    if (unsafeName(name)) reject(name, 'an unsafe path (absolute or containing `..`)');
    if (((attrs >>> 16) & 0o170000) === 0o120000) reject(name, 'a symbolic link');
    if (name.endsWith('/')) continue;
    if (out.has(name)) reject(name, 'a duplicate entry');
    if (flags & 1) reject(name, 'an encrypted entry');
    total += usize;
    if (total > maxBytes) reject(name, `the entries exceed ${maxBytes} bytes in total`);
    if (!fits(offset, 30) || v.getUint32(offset, true) !== 0x04034b50) reject(name, 'a bad local header');
    const start = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    if (!fits(start, csize)) reject(name, 'data past the end of the file');
    const body = bytes.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) data = body;
    else if (method === 8) {
      try {
        data = inflateRawSync(body, { maxOutputLength: Math.max(usize, 1) });
      } catch {
        return reject(name, 'inflates to more than, or corrupt against, its declared size');
      }
    } else return reject(name, `compression method ${method} is not supported`);
    if (data.length !== usize) reject(name, `size ${data.length} disagrees with the directory's ${usize}`);
    out.set(name, new Uint8Array(data));
  }
  // A name that is also a parent folder of another entry cannot be written to disk.
  for (const name of out.keys()) {
    for (let i = name.indexOf('/'); i >= 0; i = name.indexOf('/', i + 1)) {
      const parent = name.slice(0, i);
      if (out.has(parent)) reject(parent, 'a file and a folder of the same name');
    }
  }
  return out;
}

const ZIP_LIMIT = 0xffffffff;

/** The MS-DOS `[time, date]` words of `d` (local fields read as UTC, 1980 to 2107, two-second steps). */
function dosTime(d: Date): [number, number] {
  const y = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return [
    (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  ];
}

/**
 * D51: a stored (method 0) zip of `files` (`name` to bytes), UTF-8 names, DOS times from `mtime`, CRC32 via
 * node:zlib; no zip64 (a total above 4 GiB, or more than 65535 files, is refused with `usage`).
 * `readZip(storedZip(files))` gives `files` back.
 */
export function storedZip(files: readonly { name: string; bytes: Uint8Array; mtime: Date }[]): Uint8Array {
  const enc = new TextEncoder();
  const names = files.map((f) => enc.encode(f.name));
  let total = 22;
  files.forEach((f, i) => {
    total += 30 + 46 + 2 * (names[i]?.length ?? 0) + f.bytes.length;
  });
  if (total > ZIP_LIMIT || files.length > 0xffff)
    throw new OtelHtmlError('usage', {
      message: 'the files are too large for a zip without zip64 (4 GiB, 65535 files)',
    });
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  let pos = 0;
  const central: { at: number; crc: number; time: [number, number]; i: number }[] = [];
  files.forEach((f, i) => {
    const name = names[i] ?? new Uint8Array(0);
    const time = dosTime(f.mtime);
    const crc = crc32(f.bytes);
    central.push({ at: pos, crc, time, i });
    v.setUint32(pos, 0x04034b50, true);
    v.setUint16(pos + 4, 20, true);
    v.setUint16(pos + 6, 0x0800, true);
    v.setUint16(pos + 10, time[0], true);
    v.setUint16(pos + 12, time[1], true);
    v.setUint32(pos + 14, crc, true);
    v.setUint32(pos + 18, f.bytes.length, true);
    v.setUint32(pos + 22, f.bytes.length, true);
    v.setUint16(pos + 26, name.length, true);
    out.set(name, pos + 30);
    out.set(f.bytes, pos + 30 + name.length);
    pos += 30 + name.length + f.bytes.length;
  });
  const cdStart = pos;
  for (const c of central) {
    const name = names[c.i] ?? new Uint8Array(0);
    const size = files[c.i]?.bytes.length ?? 0;
    v.setUint32(pos, 0x02014b50, true);
    v.setUint16(pos + 4, 20, true);
    v.setUint16(pos + 6, 20, true);
    v.setUint16(pos + 8, 0x0800, true);
    v.setUint16(pos + 12, c.time[0], true);
    v.setUint16(pos + 14, c.time[1], true);
    v.setUint32(pos + 16, c.crc, true);
    v.setUint32(pos + 20, size, true);
    v.setUint32(pos + 24, size, true);
    v.setUint16(pos + 28, name.length, true);
    v.setUint32(pos + 38, (0o100644 << 16) >>> 0, true);
    v.setUint32(pos + 42, c.at, true);
    out.set(name, pos + 46);
    pos += 46 + name.length;
  }
  v.setUint32(pos, 0x06054b50, true);
  v.setUint16(pos + 8, files.length, true);
  v.setUint16(pos + 10, files.length, true);
  v.setUint32(pos + 12, pos - cdStart, true);
  v.setUint32(pos + 16, cdStart, true);
  return out;
}
