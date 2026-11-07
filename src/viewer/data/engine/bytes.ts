/** `Uint8Array.fromBase64` and `#toBase64` are not in every supported browser yet; fall back to atob/btoa. */
interface Base64Bytes {
  fromBase64?: (s: string) => Uint8Array;
}
interface Base64Instance {
  toBase64?: () => string;
}

const SLICE = 0x8000;

export function fromBase64(s: string): Uint8Array {
  const native = (Uint8Array as unknown as Base64Bytes).fromBase64;
  if (native !== undefined) return native.call(Uint8Array, s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as Base64Instance).toBase64;
  if (native !== undefined) return native.call(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i += SLICE) bin += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  return btoa(bin);
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
