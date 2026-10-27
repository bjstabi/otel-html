import { describe, expect, it, test } from 'vitest';
import {
  CATEGORICAL_DARK,
  CATEGORICAL_LIGHT,
  createColorAssigner,
  SEVERITY_DARK,
  SEVERITY_LIGHT,
  STATUS,
} from '../../src/viewer/theme/palette.js';

describe('palette', () => {
  it('has seven fixed categorical entries per mode and fixed status colours', () => {
    expect(CATEGORICAL_LIGHT).toHaveLength(7);
    expect(CATEGORICAL_DARK).toHaveLength(7);
    expect(STATUS).toEqual({ critical: '#d03b3b', warning: '#fab219' });
  });

  it('assigns first-seen order and keeps colorFor stable', () => {
    const a = createColorAssigner();
    expect(a.colorFor('checkout')).toBe(0);
    a.colorFor('cart');
    a.colorFor('search');
    expect(a.colorFor('checkout')).toBe(0);
    expect(a.colorFor('search')).toBe(2);
  });

  it('is stable when other entities come and go (independent assigners agree)', () => {
    const a = createColorAssigner();
    const first = a.colorFor('checkout');
    for (const e of ['a', 'b', 'c']) a.colorFor(e);
    expect(a.colorFor('checkout')).toBe(first);
    const b = createColorAssigner();
    expect(b.colorFor('checkout')).toBe(first);
  });

  it('maps the 8th and later entities to Other (7)', () => {
    const a = createColorAssigner();
    for (let i = 0; i < 7; i++) expect(a.colorFor(`e${i}`)).toBe(i);
    expect(a.colorFor('e7')).toBe(7);
    expect(a.colorFor('e8')).toBe(7);
    expect(a.colorFor('e0')).toBe(0);
  });
});

function luminance(hex: string): number {
  const ch = (i: number): number => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('severity colours', () => {
  const SURFACE = { light: '#ffffff', dark: '#1a1a19' } as const;
  const MUTED = { light: '#6b6f78', dark: '#96958c' } as const;
  const KEYS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
  /**
   * Light values come from the mockup and are fixed. These three are pale on white (below 3:1); they are
   * never the only encoding (every severity carries its label), so they are held to a 1.5:1 floor instead.
   */
  const PALE_LIGHT: ReadonlySet<string> = new Set(['warn', 'debug', 'trace']);

  test.each(KEYS)('%s clears non-text contrast against the dark surface (3:1)', (k) => {
    expect(contrast(SEVERITY_DARK[k], SURFACE.dark)).toBeGreaterThanOrEqual(3);
  });

  test.each(KEYS)('%s clears its contrast floor against the light surface', (k) => {
    expect(contrast(SEVERITY_LIGHT[k], SURFACE.light)).toBeGreaterThanOrEqual(PALE_LIGHT.has(k) ? 1.5 : 3);
  });

  test('unspecified (the muted token) clears text contrast (4.5:1) in both modes', () => {
    expect(contrast(MUTED.light, SURFACE.light)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(MUTED.dark, SURFACE.dark)).toBeGreaterThanOrEqual(4.5);
  });
});
