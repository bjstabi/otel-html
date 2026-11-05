import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../../src/model/bytes.js';

const reference = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('bytesToHex', () => {
  it('matches the padStart encoding for every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(bytesToHex(all)).toBe(reference(all));
    expect(bytesToHex(Uint8Array.from([0x00, 0x0f, 0xa0, 0xff]))).toBe('000fa0ff');
    expect(bytesToHex(new Uint8Array(0))).toBe('');
  });
});
