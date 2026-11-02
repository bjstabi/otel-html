import { describe, expect, it } from 'vitest';
import { RECEIVER_V8_FLAGS, v8FlagsFor } from '../../src/cli/v8-flags.js';

describe('v8FlagsFor', () => {
  it('returns the flags for serve under Node', () => {
    expect(v8FlagsFor(['serve', '--http', '0'], { node: '24' })).toBe(RECEIVER_V8_FLAGS);
  });

  it('returns the flags for run after a leading flag', () => {
    expect(v8FlagsFor(['--verbose', 'run', '--', 'cmd'], { node: '24' })).toBe(RECEIVER_V8_FLAGS);
  });

  it('returns null for other commands', () => {
    expect(v8FlagsFor(['convert', 'a.json'], { node: '24' })).toBeNull();
  });

  it('returns null under Bun', () => {
    expect(v8FlagsFor(['serve'], { bun: '1.4' })).toBeNull();
  });

  it('returns null without arguments', () => {
    expect(v8FlagsFor([], { node: '24' })).toBeNull();
  });
});
