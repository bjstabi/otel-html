import { describe, expect, it } from 'vitest';
import {
  CATEGORICAL_DARK,
  CATEGORICAL_LIGHT,
  createColorAssigner,
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
