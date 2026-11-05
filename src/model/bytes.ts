const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Lowercase hex of `b`, two chars per byte, through a lookup table. */
export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += HEX[byte] ?? '';
  return s;
}
