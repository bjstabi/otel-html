import { tableFromArrays } from '@uwdata/flechette';
import { describe, expect, test } from 'vitest';
import { facetCounts } from '../../src/viewer/data/span-results.js';

const caps = { facetValueCap: 10, facetKeyCap: 3 };

/** Attribute facet rows as `attributeFacetsQuery` returns them: one row per kept (key, value), `keys_total` on each. */
function attrs(keys: readonly string[], keysTotal: number) {
  return tableFromArrays({
    key: [...keys],
    kind: keys.map(() => 'string'),
    value: keys.map(() => 'v'),
    n: keys.map(() => 1),
    total: keys.map(() => 1),
    keys_total: keys.map(() => keysTotal),
  });
}

describe('facetCounts skippedKeyAdds', () => {
  test('without a key filter it is the keys the cap dropped', () => {
    expect(facetCounts(null, attrs(['a', 'b', 'c'], 5), caps, []).skippedKeyAdds).toBe(2);
  });

  test('under a facetKeys filter it is not overstated by the keys nobody asked for', () => {
    // 5 keys exist, the cap kept 3, the caller asked for `a` only and got it: nothing it wanted was dropped.
    const f = facetCounts(null, attrs(['a', 'b', 'c'], 5), caps, [], new Set(['a']));
    expect(f.skippedKeyAdds).toBe(0);
    expect(f.keys()).toEqual(['a']);
  });

  test('under a facetKeys filter a requested key the cap dropped counts as dropped', () => {
    const f = facetCounts(null, attrs(['a', 'b', 'c'], 5), caps, [], new Set(['a', 'z']));
    expect(f.skippedKeyAdds).toBe(1);
  });

  test('under a facetKeys filter with the cap not reached nothing is dropped', () => {
    const f = facetCounts(null, attrs(['a', 'b'], 2), caps, [], new Set(['a', 'z']));
    expect(f.skippedKeyAdds).toBe(0);
  });
});
