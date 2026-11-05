import { describe, expect, it } from 'vitest';
import { bytesToBase64, bytesToHex } from '../../src/model/bytes.js';

const reference = (b: Uint8Array): string => Buffer.from(b).toString('base64');

describe('bytesToBase64', () => {
  it('matches the standard padded alphabet for lengths 0..5 and for every byte value', () => {
    for (let n = 0; n <= 5; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 51 + 7) & 0xff);
      expect(bytesToBase64(b)).toBe(reference(b));
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(bytesToBase64(all)).toBe(reference(all));
  });
  it('pads and handles empty input', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('');
    expect(bytesToBase64(new Uint8Array([0xff]))).toBe('/w==');
    expect(bytesToBase64(new Uint8Array([0xff, 0xfe]))).toBe('//4=');
  });
});

describe('bytesToHex', () => {
  it('is lower-case, two digits per byte, for every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(bytesToHex(all)).toBe(Array.from(all, (x) => x.toString(16).padStart(2, '0')).join(''));
    expect(bytesToHex(new Uint8Array([0x0a, 0xff]))).toBe('0aff');
    expect(bytesToHex(new Uint8Array(0))).toBe('');
    expect(bytesToHex(Uint8Array.from([0x00, 0x0f, 0xa0, 0xff]))).toBe('000fa0ff');
  });
});
