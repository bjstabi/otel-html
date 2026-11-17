import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { sha256Hex } from '../../src/model/sha256.js';

const reference = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  test('the empty text and "abc" match the published digests', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('a 1,000-character non-ASCII text matches node:crypto', () => {
    const text = Array.from({ length: 1000 }, (_, i) =>
      String.fromCodePoint(0x4e00 + ((i * 37) % 2000)),
    ).join('');
    expect(sha256Hex(text)).toBe(reference(text));
  });

  test('every padding boundary around one and two blocks matches node:crypto', () => {
    for (const n of [54, 55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      expect(sha256Hex('x'.repeat(n)), String(n)).toBe(reference('x'.repeat(n)));
    }
  });
});
