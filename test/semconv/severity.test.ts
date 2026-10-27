import { describe, expect, it } from 'vitest';
import { ENUMS } from '../../src/ottl/contexts.js';
import {
  LOG_SEVERITY_KEYS,
  SEVERITY_BANDS,
  severityEnumName,
  severityKey,
} from '../../src/semconv/severity.js';

describe('severity bands', () => {
  it('cover 0..24 contiguously, in display order', () => {
    let next = 0;
    for (const k of LOG_SEVERITY_KEYS) {
      expect(SEVERITY_BANDS[k].min).toBe(next);
      next = SEVERITY_BANDS[k].max + 1;
    }
    expect(next).toBe(25);
  });

  it('classify every severity number into its band', () => {
    for (const k of LOG_SEVERITY_KEYS) {
      for (let n = SEVERITY_BANDS[k].min; n <= SEVERITY_BANDS[k].max; n++) expect(severityKey(n)).toBe(k);
    }
    expect(() => severityKey(25)).toThrow(RangeError);
  });

  it('name OTTL enums that resolve to their number', () => {
    expect(severityEnumName('warn', 13)).toBe('SEVERITY_NUMBER_WARN');
    expect(severityEnumName('warn', 16)).toBe('SEVERITY_NUMBER_WARN4');
    expect(ENUMS.get(severityEnumName('fatal', 24))).toBe(24n);
    expect(ENUMS.get('SEVERITY_NUMBER_UNSPECIFIED')).toBe(0n);
  });
});
