import { wrapBinaryDataFilePieces, wrapBinaryDataFilePiecesOf } from '../format/data-file.js';
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

/**
 * `writeWrapper` of the file at `file`, read back in chunks and wrapped as they come, so a large file is never held
 * whole. Where the file system cannot read in chunks or write pieces, the file is read whole and wrapped.
 */
export async function writeWrapperOfFile(
  fs: FileSystem,
  path: string,
  key: string,
  file: string,
): Promise<void> {
  if (fs.readChunks === undefined || fs.writePiecesAtomic === undefined) {
    await writeWrapper(fs, path, key, await fs.readBytes(file));
    return;
  }
  await fs.writePiecesAtomic(path, wrapBinaryDataFilePiecesOf(key, fs.readChunks(file), encodeSlice));
}
