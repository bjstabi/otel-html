import { wrapBinaryDataFilePieces } from '../format/data-file.js';
import type { FileSystem } from './ports.js';

type WithToBase64 = Uint8Array & { toBase64?: () => string };

/** Base64 of a slice: the native `toBase64` where the runtime has it (Bun), else Node's `Buffer` (protobuf's encoder builds a rope, ~45x the input in memory). */
function encodeSlice(slice: Uint8Array): string {
  const native = (slice as WithToBase64).toBase64;
  if (native !== undefined) return native.call(slice);
  return Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('base64');
}

/** Writes a local-format wrapper for `bytes` without building it as one string. */
export async function writeWrapper(
  fs: FileSystem,
  path: string,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  const pieces = wrapBinaryDataFilePieces(key, bytes, encodeSlice);
  if (fs.writePiecesAtomic !== undefined) await fs.writePiecesAtomic(path, pieces);
  else await fs.writeTextAtomic(path, [...pieces].join(''));
}
