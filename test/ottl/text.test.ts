import { describe, expect, test } from 'vitest';
import { matchesText, spanTextFields } from '../../src/ottl/text.js';
import { spanTarget } from './fixtures.js';

describe('free text', () => {
  const target = spanTarget();
  test('case-insensitive contains over values', () => {
    expect(matchesText('CART', spanTextFields(target))).toBe(true);
  });
  test.each([
    ['get /API', true], // name
    ['UPSTREAM', true], // status message
    ['503', true], // int attribute value
    ['checkout', true], // resource attribute value
    ['deep', true], // nested kvlist value
    ['http.route', false], // keys are not searched
    ['my.lib', false],
    ['nope', false],
    ['', true],
  ])('%s → %s', (q, expected) => {
    expect(matchesText(q, spanTextFields(target))).toBe(expected);
  });
  test('empty haystack', () => {
    expect(matchesText('x', [])).toBe(false);
  });
});
