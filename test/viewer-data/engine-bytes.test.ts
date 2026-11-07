import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { fromBase64, gunzip, toBase64 } from '../../src/viewer/data/engine/bytes.js';

test('base64 round-trips and gunzip inverts gzipSync', async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
  expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  expect(await gunzip(new Uint8Array(gzipSync(Buffer.from('hello'))))).toEqual(
    new TextEncoder().encode('hello'),
  );
});

test('base64 handles input longer than one 32 KiB slice', () => {
  const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
  expect(fromBase64(toBase64(bytes))).toEqual(bytes);
});
