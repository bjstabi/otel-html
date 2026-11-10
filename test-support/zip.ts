import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  name: string;
  data: Uint8Array | string;
  /** Default `stored`. */
  method?: 'stored' | 'deflate';
  /** The central directory's external attributes (unix mode in the high 16 bits). Default 0o100644 << 16. */
  attrs?: number;
  /** An uncompressed size to declare in place of the real one. */
  declaredSize?: number;
}

const enc = new TextEncoder();

/** A zip built by hand: local headers, central directory and end record, with the quirks a reader must reject or accept. */
export function buildZip(entries: ZipEntrySpec[], options: { zip64?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (b: Uint8Array): void => {
    parts.push(b);
    offset += b.length;
  };
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const method = e.method === 'deflate' ? 8 : 0;
    const body = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = enc.encode(e.name);
    const usize = e.declaredSize ?? raw.length;
    const crc = crc32(raw);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, usize, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const localOffset = offset;
    push(local);
    push(body);

    const extra = options.zip64 ? new Uint8Array(4 + 24) : new Uint8Array(0);
    if (options.zip64) {
      const ev = new DataView(extra.buffer);
      ev.setUint16(0, 1, true);
      ev.setUint16(2, 24, true);
      ev.setBigUint64(4, BigInt(usize), true);
      ev.setBigUint64(12, BigInt(body.length), true);
      ev.setBigUint64(20, BigInt(localOffset), true);
    }
    const c = new Uint8Array(46 + name.length + extra.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 0x031e, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, options.zip64 ? 0xffffffff : body.length, true);
    cv.setUint32(24, options.zip64 ? 0xffffffff : usize, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint32(38, e.attrs ?? (0o100644 << 16) >>> 0, true);
    cv.setUint32(42, options.zip64 ? 0xffffffff : localOffset, true);
    c.set(name, 46);
    c.set(extra, 46 + name.length);
    central.push(c);
  }
  const cdOffset = offset;
  for (const c of central) push(c);
  const cdSize = offset - cdOffset;
  if (options.zip64) {
    const z = new Uint8Array(56 + 20);
    const zv = new DataView(z.buffer);
    zv.setUint32(0, 0x06064b50, true);
    zv.setBigUint64(4, 44n, true);
    zv.setUint16(12, 45, true);
    zv.setUint16(14, 45, true);
    zv.setBigUint64(24, BigInt(entries.length), true);
    zv.setBigUint64(32, BigInt(entries.length), true);
    zv.setBigUint64(40, BigInt(cdSize), true);
    zv.setBigUint64(48, BigInt(cdOffset), true);
    zv.setUint32(56, 0x07064b50, true);
    zv.setBigUint64(64, BigInt(offset), true);
    zv.setUint32(72, 1, true);
    push(z);
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, options.zip64 ? 0xffff : entries.length, true);
  ev.setUint16(10, options.zip64 ? 0xffff : entries.length, true);
  ev.setUint32(12, options.zip64 ? 0xffffffff : cdSize, true);
  ev.setUint32(16, options.zip64 ? 0xffffffff : cdOffset, true);
  push(end);
  const out = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
