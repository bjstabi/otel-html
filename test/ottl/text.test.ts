import { describe, expect, test } from 'vitest';
import { logTextFields, matchesText, spanTextFields } from '../../src/ottl/text.js';
import { logTarget, spanTarget } from './fixtures.js';

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

describe('log free text', () => {
  const target = logTarget({ eventName: 'payment.failed' });
  test.each([
    ['DECLINED', true], // body
    ['error', true], // severity text
    ['payment.FAILED', true], // event name
    ['42', true], // log attribute value
    ['checkout', true], // resource attribute value
    ['code', false], // keys are not searched
    ['nope', false],
  ])('%s -> %s', (q, expected) => {
    expect(matchesText(q, logTextFields(target))).toBe(expected);
  });
});
