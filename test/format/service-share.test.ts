import { describe, expect, test } from 'vitest';
import {
  decodeServiceShare,
  encodeServiceShare,
  type ShareSpan,
  serviceShareOf,
} from '../../src/format/service-share.js';
import { OtelHtmlError } from '../../src/model/errors.js';

function span(
  spanId: string,
  parentId: string | null,
  start: number,
  end: number,
  service = 's',
  provisional = false,
): ShareSpan {
  return { spanId, parentId, service, start, end, durationNs: end - start, provisional };
}

describe('serviceShareOf', () => {
  test('a child takes its time from its parent', () => {
    const got = serviceShareOf([span('a', null, 0, 100, 'api'), span('b', 'a', 20, 50, 'db')]);
    expect(got).toEqual([
      { service: 'api', ns: 70n },
      { service: 'db', ns: 30n },
    ]);
  });

  test('overlapping children are counted once', () => {
    const got = serviceShareOf([
      span('a', null, 0, 100, 'p'),
      span('b', 'a', 10, 50, 'c'),
      span('c', 'a', 30, 70, 'c'),
    ]);
    expect(got).toEqual([
      { service: 'c', ns: 80n },
      { service: 'p', ns: 40n },
    ]);
  });

  test('totals past 2^53 are exact', () => {
    const half = 2 ** 52;
    const got = serviceShareOf([span('a', null, 0, half), span('b', null, 0, half + 1)]);
    expect(got).toEqual([{ service: 's', ns: 2n ** 53n + 1n }]);
    expect(encodeServiceShare(got)).toContain('9007199254740993');
  });

  test('of two copies ending 1 ns apart the later one is kept', () => {
    const a = span('a', null, 0, 100);
    const b = span('a', null, 0, 101);
    expect(serviceShareOf([a, b])).toEqual([{ service: 's', ns: 101n }]);
    expect(serviceShareOf([b, a])).toEqual([{ service: 's', ns: 101n }]);
  });

  test('an orphan counts as a root', () => {
    expect(serviceShareOf([span('b', 'missing', 0, 40)])).toEqual([{ service: 's', ns: 40n }]);
  });

  test('the final copy wins over a longer provisional one', () => {
    const got = serviceShareOf([span('a', null, 0, 100, 's', true), span('a', null, 0, 80)]);
    expect(got).toEqual([{ service: 's', ns: 80n }]);
  });

  test('ties are ordered by service name', () => {
    expect(
      serviceShareOf([span('a', null, 0, 5, 'z'), span('b', null, 0, 5, 'a')]).map((e) => e.service),
    ).toEqual(['a', 'z']);
  });

  test('a parent cycle is broken at the earliest span', () => {
    const got = serviceShareOf([span('a', 'b', 0, 100, 'x'), span('b', 'a', 10, 40, 'y')]);
    expect(got).toEqual([
      { service: 'x', ns: 70n },
      { service: 'y', ns: 30n },
    ]);
  });

  test('a self-parent span is a root', () => {
    expect(serviceShareOf([span('a', 'a', 0, 50, 'x')])).toEqual([{ service: 'x', ns: 50n }]);
  });

  test('a child starting before its parent is clipped to the parent', () => {
    const got = serviceShareOf([span('p', null, 20, 100, 'x'), span('c', 'p', 10, 50, 'y')]);
    expect(got).toEqual([
      { service: 'x', ns: 50n },
      { service: 'y', ns: 40n },
    ]);
  });

  test('an empty list is empty', () => {
    expect(serviceShareOf([])).toEqual([]);
  });
});

describe('encode and decode', () => {
  test('round trip with decimal strings', () => {
    const s = [
      { service: 'api', ns: 70n },
      { service: 'db', ns: 30n },
    ];
    const text = encodeServiceShare(s);
    expect(text).toBe('[["api","70"],["db","30"]]');
    expect(decodeServiceShare(text)).toEqual(s);
  });

  test.each(['not json', '{}', '[["a"]]', '[["a",5]]', '[["a","-1"]]'])('rejects %s', (text) => {
    expect(() => decodeServiceShare(text)).toThrow(OtelHtmlError);
  });
});
